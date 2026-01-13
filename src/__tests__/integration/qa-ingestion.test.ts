import { prisma } from '@/lib/prisma';
import { shouldEnqueueExternalSearch, normalizeSearchQuery, recordSearchIntent } from '@/lib/search-utils';
import { runMasterScheduler } from '@/workers/schedulers/master.scheduler';
import { syncSourceQueue, chapterIngestQueue } from '@/lib/queues';
import { sourceRateLimiter } from '@/lib/rate-limiter';
import { redis } from '@/lib/redis';

// Mock BullMQ queues
jest.mock('@/lib/queues', () => ({
  syncSourceQueue: {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
    addBulk: jest.fn().mockResolvedValue([]),
    getJob: jest.fn().mockResolvedValue(null),
  },
  chapterIngestQueue: {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
    addBulk: jest.fn().mockResolvedValue([]),
  },
  isQueueHealthy: jest.fn().mockResolvedValue(true),
  getNotificationSystemHealth: jest.fn().mockResolvedValue({ isCritical: false }),
}));

// Mock sub-schedulers to avoid side effects
jest.mock('@/workers/schedulers/cover-refresh.scheduler', () => ({ runCoverRefreshScheduler: jest.fn() }));
jest.mock('@/workers/schedulers/deferred-search.scheduler', () => ({ runDeferredSearchScheduler: jest.fn() }));
jest.mock('@/workers/schedulers/notification-digest.scheduler', () => ({ runNotificationDigestScheduler: jest.fn() }));
jest.mock('@/workers/schedulers/safety-monitor.scheduler', () => ({ runSafetyMonitor: jest.fn() }));
jest.mock('@/workers/schedulers/cleanup.scheduler', () => ({ runCleanupScheduler: jest.fn() }));
jest.mock('@/workers/schedulers/tier-maintenance.scheduler', () => ({ runTierMaintenanceScheduler: jest.fn() }));
jest.mock('@/workers/schedulers/latest-feed.scheduler', () => ({ runLatestFeedScheduler: jest.fn() }));

describe('QA Ingestion Architecture Verification', () => {
  const TEST_QUERY = 'https://mangadex.org/title/test-123';
  const NORMALIZED_KEY = normalizeSearchQuery(TEST_QUERY);

  beforeEach(async () => {
    // Clear test data
    await prisma.queryStats.deleteMany({ where: { normalized_key: NORMALIZED_KEY } });
    await redis.del(`kenmei:query:users:${NORMALIZED_KEY}`);
    jest.clearAllMocks();
  });

  describe('1. 100k users search simultaneously → no crawl storm', () => {
    it('should only allow enqueuing after threshold is met and respect 30s cooldown', async () => {
      const queue = syncSourceQueue as any;

      // First search - should not enqueue (below threshold)
      await recordSearchIntent(NORMALIZED_KEY, 'user1');
      let decision = await shouldEnqueueExternalSearch(NORMALIZED_KEY, queue);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('below_threshold');

      // Second search - meets threshold (total_searches=2)
      await recordSearchIntent(NORMALIZED_KEY, 'user2');
      decision = await shouldEnqueueExternalSearch(NORMALIZED_KEY, queue);
      expect(decision.shouldEnqueue).toBe(true);

      // Simulate enqueuing
      await prisma.queryStats.update({
        where: { normalized_key: NORMALIZED_KEY },
        data: { last_enqueued_at: new Date() }
      });

      // Third search (simultaneous/immediate) - should be blocked by cooldown
      decision = await shouldEnqueueExternalSearch(NORMALIZED_KEY, queue);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('cooldown');

      // Simulate job active in queue
      queue.getJob.mockResolvedValueOnce({
        getState: () => Promise.resolve('waiting')
      });
      
      // Even if cooldown passed, if job is active, don't duplicate
      await prisma.queryStats.update({
        where: { normalized_key: NORMALIZED_KEY },
        data: { last_enqueued_at: new Date(Date.now() - 40000) }
      });
      
      decision = await shouldEnqueueExternalSearch(NORMALIZED_KEY, queue);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('active_job');
    });
  });

  describe('2. Tier C series never polled', () => {
    it('should filter out Tier C series from scheduler', async () => {
      // Setup test data
      const seriesA = await prisma.series.create({
        data: {
          title: 'Tier A Series',
          catalog_tier: 'A',
          type: 'MANGA',
          sources: {
            create: {
              source_name: 'mangadex',
              source_id: 'a1',
              source_url: 'https://mangadex.org/title/a1',
              next_check_at: new Date(Date.now() - 1000), // Due
            }
          }
        }
      });

      const seriesC = await prisma.series.create({
        data: {
          title: 'Tier C Series',
          catalog_tier: 'C',
          type: 'MANGA',
          sources: {
            create: {
              source_name: 'mangadex',
              source_id: 'c1',
              source_url: 'https://mangadex.org/title/c1',
              next_check_at: new Date(Date.now() - 1000), // Due but Tier C
            }
          }
        }
      });

      await runMasterScheduler();

      // Verify syncSourceQueue.addBulk was called with Tier A but NOT Tier C
      const addBulkCalls = (syncSourceQueue.addBulk as jest.Mock).mock.calls;
      expect(addBulkCalls.length).toBeGreaterThan(0);
      
      const enqueuedJobs = addBulkCalls.flatMap(call => call[0]);
      const sourceIds = enqueuedJobs.map(job => job.data.seriesSourceId);

      const sourceA = await prisma.seriesSource.findFirst({ where: { series_id: seriesA.id } });
      const sourceC = await prisma.seriesSource.findFirst({ where: { series_id: seriesC.id } });

      expect(sourceIds).toContain(sourceA?.id);
      expect(sourceIds).not.toContain(sourceC?.id);

      // Cleanup
      await prisma.seriesSource.deleteMany({ where: { series_id: { in: [seriesA.id, seriesC.id] } } });
      await prisma.series.deleteMany({ where: { id: { in: [seriesA.id, seriesC.id] } } });
    });
  });

  describe('3. Source rate limits respected', () => {
    it('should correctly calculate wait times for token bucket', async () => {
      const sourceName = 'mangadex'; // 5 rps
      
      // Clear Redis state for rate limiter
      await redis.del(`kenmei:ratelimit:${sourceName}:tokens`);
      await redis.del(`kenmei:ratelimit:${sourceName}:last_refill`);

      // First token - immediate
      const start = Date.now();
      const acquired1 = await sourceRateLimiter.acquireToken(sourceName);
      expect(acquired1).toBe(true);
      
      // Deplete all tokens (burst=10)
      for (let i = 0; i < 9; i++) {
        await sourceRateLimiter.acquireToken(sourceName);
      }

      // Next token should require wait (5 rps = 200ms per token)
      const waitStart = Date.now();
      const acquiredDelayed = await sourceRateLimiter.acquireToken(sourceName);
      const waitDuration = Date.now() - waitStart;
      
      expect(acquiredDelayed).toBe(true);
      // It should have waited roughly 200ms (we use 200ms cooldown + refill time)
      expect(waitDuration).toBeGreaterThanOrEqual(200);
    });
  });

  describe('4. Queue backlog prevents new jobs', () => {
    it('should skip scheduling when syncSourceQueue backlog is high', async () => {
      (syncSourceQueue.getJobCounts as jest.Mock).mockResolvedValueOnce({ waiting: 10001 });
      
      await runMasterScheduler();
      
      // addBulk should NOT be called if backlog is too high
      expect(syncSourceQueue.addBulk).not.toHaveBeenCalled();
    });
  });
});
