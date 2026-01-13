import { prisma } from '@/lib/prisma';
import { syncSourceQueue } from '@/lib/queues';
import { withLock } from '@/lib/redis';
import { SyncSourceSchema } from '@/lib/schemas/queue-payloads';
import { CrawlGatekeeper } from '@/lib/crawl-gatekeeper';
import { negativeResultCache } from '@/lib/rate-limiter';
import { JOB_PRIORITIES, type PriorityMetadata } from '@/lib/job-config';
import { runCoverRefreshScheduler } from './cover-refresh.scheduler';
import { runDeferredSearchScheduler } from './deferred-search.scheduler';
import { runNotificationDigestScheduler } from './notification-digest.scheduler';
import { runSafetyMonitor } from './safety-monitor.scheduler';
import { runCleanupScheduler } from './cleanup.scheduler';
import { runTierMaintenanceScheduler } from './tier-maintenance.scheduler';
import { runLatestFeedScheduler } from './latest-feed.scheduler';
import { runNotificationTimingScheduler } from './notification-timing.scheduler';
import { runRecommendationsScheduler } from './recommendations.scheduler';

export const SYNC_INTERVALS_BY_TIER = {
  A: {
    HOT: 30 * 60 * 1000,
    WARM: 45 * 60 * 1000,
    COLD: 60 * 60 * 1000,
  },
  B: {
    HOT: 6 * 60 * 60 * 1000,
    WARM: 9 * 60 * 60 * 1000,
    COLD: 12 * 60 * 60 * 1000,
  },
  C: {
    HOT: 48 * 60 * 60 * 1000,
    WARM: 72 * 60 * 60 * 1000,
    COLD: 7 * 24 * 60 * 60 * 1000,
  },
} as const;

type SyncPriority = 'HOT' | 'WARM' | 'COLD';

const GATEKEEPER_BATCH_SIZE = 50;

async function maintenancePriorities() {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log('[Scheduler] Running priority maintenance...');

  const popularPromotions = await prisma.seriesSource.updateMany({
    where: {
      sync_priority: { not: 'HOT' },
      series: {
        stats: {
          total_readers: { gt: 100 }
        }
      }
    },
    data: { sync_priority: 'HOT' }
  });

  const hotDowngrades = await prisma.seriesSource.updateMany({
    where: {
      sync_priority: 'HOT',
      last_success_at: { lt: oneDayAgo },
      series: {
        OR: [
          { stats: { total_readers: { lte: 100 } } },
          { stats: null }
        ]
      }
    },
    data: { sync_priority: 'WARM' }
  });

  const warmDowngrades = await prisma.seriesSource.updateMany({
    where: {
      sync_priority: 'WARM',
      last_success_at: { lt: sevenDaysAgo }
    },
    data: { sync_priority: 'COLD' }
  });

  console.log(`[Scheduler] Maintenance complete: ${popularPromotions.count} promoted to HOT, ${hotDowngrades.count} downgraded to WARM, ${warmDowngrades.count} downgraded to COLD`);
}

async function runSchedulerTask(name: string, task: () => Promise<void>) {
  try {
    await task();
  } catch (error) {
    console.error(`[Scheduler] ${name} failed:`, error);
  }
}

export async function runMasterScheduler() {
  return await withLock('scheduler:master', 360000, async () => {
    const startTime = Date.now();
    console.log('[Scheduler] Running master scheduler...');

    const now = new Date();

    await runSchedulerTask('Priority maintenance', maintenancePriorities);
    await runSchedulerTask('Cover refresh scheduler', runCoverRefreshScheduler);
    await runSchedulerTask('Deferred search scheduler', runDeferredSearchScheduler);
    await runSchedulerTask('Notification digest scheduler', runNotificationDigestScheduler);
    await runSchedulerTask('Safety monitor', runSafetyMonitor);
    await runSchedulerTask('Cleanup scheduler', runCleanupScheduler);
    await runSchedulerTask('Tier maintenance scheduler', runTierMaintenanceScheduler);
    await runSchedulerTask('Latest feed scheduler', runLatestFeedScheduler);
    await runSchedulerTask('Notification timing scheduler', runNotificationTimingScheduler);
    await runSchedulerTask('Recommendations scheduler', runRecommendationsScheduler);

    try {
      const sourcesToUpdate = await prisma.seriesSource.findMany({
        where: {
          series: {
            catalog_tier: { in: ['A', 'B', 'C'] },
            deleted_at: null,
          },
          source_status: { not: 'broken' },
          OR: [
            { next_check_at: { lte: now } },
            { next_check_at: null }
          ]
        },
        include: {
          series: { 
            select: { 
              catalog_tier: true,
              total_follows: true,
              last_chapter_at: true
            } 
          }
        },
        take: 500,
      });

      if (sourcesToUpdate.length === 0) {
        console.log('[Scheduler] No sources due for sync.');
        return;
      }

      const updatesByTierAndPriority: Record<string, Record<string, string[]>> = {
        A: { HOT: [], WARM: [], COLD: [] },
        B: { HOT: [], WARM: [], COLD: [] },
        C: { HOT: [], WARM: [], COLD: [] },
      };

      const jobs: Array<{
        name: string;
        data: { seriesSourceId: string };
        opts: { jobId: string; priority: number; removeOnComplete: boolean; removeOnFail: { age: number } };
      }> = [];
      let skippedCount = 0;
      let negativeSkipped = 0;

      for (let i = 0; i < sourcesToUpdate.length; i += GATEKEEPER_BATCH_SIZE) {
        const batch = sourcesToUpdate.slice(i, i + GATEKEEPER_BATCH_SIZE);
        
        for (const source of batch) {
          const tier = source.series?.catalog_tier || 'C';
          const priority = (source.sync_priority as SyncPriority) || 'COLD';
          
          if (updatesByTierAndPriority[tier]?.[priority]) {
            updatesByTierAndPriority[tier][priority].push(source.id);
          } else if (updatesByTierAndPriority[tier]) {
            updatesByTierAndPriority[tier].COLD.push(source.id);
          }

          const shouldSkipNegative = await negativeResultCache.shouldSkip(source.id);
          if (shouldSkipNegative) {
            negativeSkipped++;
            continue;
          }

          const metadata: PriorityMetadata = {
            trackerCount: source.series?.total_follows ?? 0,
            lastActivity: source.series?.last_chapter_at ?? null,
            isDiscovery: false,
          };

          const decision = await CrawlGatekeeper.shouldEnqueue(source.id, tier, 'PERIODIC', metadata);

          if (!decision.allowed) {
            skippedCount++;
            continue;
          }

          const validation = SyncSourceSchema.safeParse({ seriesSourceId: source.id });

          if (!validation.success) {
            console.error(`[Validation][Skipped] queue=sync-source reason="Invalid ID" id=${source.id}`);
            continue;
          }

          jobs.push({
            name: `sync-${source.id}`,
            data: validation.data,
            opts: {
              jobId: `sync-${source.id}`,
              priority: JOB_PRIORITIES[decision.jobPriority],
              removeOnComplete: true,
              removeOnFail: { age: 24 * 3600 }
            }
          });
        }
      }

      const updatePromises: Promise<{ count: number }>[] = [];
      for (const [tier, priorities] of Object.entries(updatesByTierAndPriority)) {
        for (const [priority, ids] of Object.entries(priorities)) {
          if (ids.length === 0) continue;
          
          const tierIntervals = SYNC_INTERVALS_BY_TIER[tier as keyof typeof SYNC_INTERVALS_BY_TIER];
          const interval = tierIntervals[priority as SyncPriority];
          const nextCheck = new Date(now.getTime() + interval);

          updatePromises.push(
            prisma.seriesSource.updateMany({
              where: { id: { in: ids } },
              data: { next_check_at: nextCheck }
            })
          );
        }
      }

      await Promise.all(updatePromises);

      if (jobs.length > 0) {
        await syncSourceQueue.addBulk(jobs);
        console.log(`[Scheduler] Queued ${jobs.length} jobs, skipped ${skippedCount} by gatekeeper, ${negativeSkipped} by negative cache, updated next_check_at for ${sourcesToUpdate.length} sources`);
      } else {
        console.log(`[Scheduler] No jobs to enqueue (skipped ${skippedCount} gatekeeper, ${negativeSkipped} negative), updated next_check_at for ${sourcesToUpdate.length} sources`);
      }

    } catch (error) {
      console.error('[Scheduler] Sync source scheduler failed:', error);
    }

    const duration = Date.now() - startTime;
    console.log(`[Scheduler] Master scheduler completed in ${duration}ms`);
  });
}
