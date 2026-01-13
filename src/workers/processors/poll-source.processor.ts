import { Job } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { scrapers, ScraperError, validateSourceUrl, RateLimitError, ProxyBlockedError } from '@/lib/scrapers';
import { chapterIngestQueue, getNotificationSystemHealth } from '@/lib/queues';
import { sourceRateLimiter, negativeResultCache } from '@/lib/rate-limiter';
import { BACKOFF_CONFIG } from '@/lib/job-config';
import { z } from 'zod';

const MAX_CONSECUTIVE_FAILURES = 5;
const RATE_LIMIT_TIMEOUT_MS = 60000;
const MAX_INGEST_QUEUE_SIZE = 50000;

const PollSourceDataSchema = z.object({
  seriesSourceId: z.string().uuid(),
  targetChapters: z.array(z.number()).optional(),
});

export interface PollSourceData {
  seriesSourceId: string;
  targetChapters?: number[];
}

export async function processPollSource(job: Job<PollSourceData>) {
  const jobId = job.id || 'unknown';
  
  if (!job.data || !job.data.seriesSourceId || job.data.seriesSourceId === 'undefined') {
    console.error(`[PollSource][${jobId}] CRITICAL: Received job with null/undefined seriesSourceId. Data:`, JSON.stringify(job.data));
    return;
  }

  const seriesSourceId = job.data.seriesSourceId;
  console.log(`[PollSource][${jobId}] Starting process for source ID: ${seriesSourceId}`);

  const parseResult = PollSourceDataSchema.safeParse(job.data);
  if (!parseResult.success) {
    console.error(`[PollSource][${jobId}] Invalid job payload:`, parseResult.error.format());
    return;
  }

  const source = await prisma.seriesSource.findUnique({
    where: { id: seriesSourceId },
    include: { series: true }
  });

  if (!source) {
    console.warn(`[PollSource][${jobId}] Source ${seriesSourceId} not found, skipping`);
    return;
  }

  const systemHealth = await getNotificationSystemHealth();
  const ingestQueueCounts = await chapterIngestQueue.getJobCounts('waiting');
  
  if (systemHealth.isCritical || ingestQueueCounts.waiting > MAX_INGEST_QUEUE_SIZE) {
    console.warn(`[PollSource][${jobId}] System under high load (waiting: ${ingestQueueCounts.waiting}), delaying poll for ${source.source_title || source.source_url}`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        next_check_at: new Date(Date.now() + 15 * 60 * 1000),
      }
    });
    return;
  }

  if (source.failure_count >= MAX_CONSECUTIVE_FAILURES) {
    const lastChecked = source.last_checked_at ? new Date(source.last_checked_at).getTime() : 0;
    const cooldownPeriod = 60 * 60 * 1000;

    if (Date.now() - lastChecked > cooldownPeriod) {
      console.info(`[PollSource][${jobId}] Cooldown expired for ${seriesSourceId}, attempting auto-reset probe`);
    } else {
      console.warn(`[PollSource][${jobId}] Circuit breaker open for ${seriesSourceId} (${source.failure_count} failures). Cooldown active (60m).`);
      await prisma.seriesSource.update({
        where: { id: source.id },
        data: {
          sync_priority: 'COLD',
          source_status: 'broken',
          next_check_at: new Date(Date.now() + 60 * 60 * 1000),
        }
      });
      return;
    }
  }

  if (!validateSourceUrl(source.source_url)) {
    console.error(`[PollSource][${jobId}] Invalid source URL for ${seriesSourceId}`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        failure_count: { increment: 1 },
        last_checked_at: new Date(),
      }
    });
    return;
  }

  const scraper = scrapers[source.source_name.toLowerCase()];
  if (!scraper) {
    console.error(`[PollSource][${jobId}] No scraper for source ${source.source_name}`);
    return;
  }

  const sourceName = source.source_name.toLowerCase();
  console.log(`[PollSource][${jobId}] Waiting for rate limit token for ${sourceName}...`);
  
  const tokenAcquired = await sourceRateLimiter.acquireToken(sourceName, RATE_LIMIT_TIMEOUT_MS);
  
  if (!tokenAcquired) {
    console.warn(`[PollSource][${jobId}] Rate limit timeout for ${sourceName}, rescheduling`);
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        next_check_at: new Date(Date.now() + 5 * 60 * 1000),
      }
    });
    return;
  }

  try {
    console.log(`[PollSource][${jobId}] Polling ${source.source_name} for ${source.source_title || source.source_url}...`);
    const scrapedData = await scraper.scrapeSeries(source.source_id, job.data.targetChapters);
    
    if (scrapedData.sourceId !== source.source_id && source.source_name.toLowerCase() === 'mangadex') {
      console.log(`[PollSource][${jobId}] Updating sourceId for ${source.id} from ${source.source_id} to ${scrapedData.sourceId}`);
      await prisma.seriesSource.update({
        where: { id: source.id },
        data: { source_id: scrapedData.sourceId }
      });
    }

    const isEmpty = scrapedData.chapters.length === 0;
    await negativeResultCache.recordResult(seriesSourceId, isEmpty);

    if (isEmpty) {
      console.log(`[PollSource][${jobId}] No chapters found for ${source.source_title || source.source_url}, recording negative result`);
      await prisma.seriesSource.update({
        where: { id: source.id },
        data: {
          last_checked_at: new Date(),
          last_success_at: new Date(),
          failure_count: 0,
        }
      });
      return;
    }

    const ingestJobs = scrapedData.chapters.map(chapter => {
      const chapterNumberStr = chapter.chapterNumber.toString();
      const dedupKey = `${source.id}-${chapterNumberStr}`;
      
      return {
        name: `ingest-${dedupKey}`,
        data: {
          seriesSourceId: source.id,
          seriesId: source.series_id || null,
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.chapterTitle || null,
          chapterUrl: chapter.chapterUrl,
          sourceChapterId: chapter.sourceChapterId || null,
          publishedAt: chapter.publishedAt ? chapter.publishedAt.toISOString() : null,
          traceId: jobId,
        },
        opts: {
          jobId: `ingest-${dedupKey}`,
          attempts: 3,
          backoff: {
            type: 'exponential' as const,
            delay: 1000,
          }
        }
      };
    });

    if (ingestJobs.length > 0) {
      await chapterIngestQueue.addBulk(ingestJobs);
      console.log(`[PollSource][${jobId}] Enqueued ${ingestJobs.length} ingestion jobs for ${source.source_title || source.source_url}`);
    }

    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        last_checked_at: new Date(),
        last_success_at: new Date(),
        failure_count: 0,
      }
    });

  } catch (error) {
    let isRetryable = true;
    let nextCheckDelayMs = 15 * 60 * 1000;

    if (error instanceof ScraperError && error.code === 'PROVIDER_NOT_IMPLEMENTED') {
      console.info(`[PollSource][${jobId}] Source ${source.source_name} is not implemented yet. Marking as inactive.`);
      await prisma.seriesSource.update({
        where: { id: source.id },
        data: {
          source_status: 'inactive',
          last_checked_at: new Date(),
          next_check_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }
      });
      return;
    }

    if (error instanceof RateLimitError) {
      console.warn(`[PollSource][${jobId}] Rate limited by source ${source.source_name}, backing off 1 hour`);
      nextCheckDelayMs = BACKOFF_CONFIG.RATE_LIMIT_MS;
      isRetryable = true;
    } else if (error instanceof ProxyBlockedError) {
      console.warn(`[PollSource][${jobId}] Proxy blocked for ${source.source_name}, backing off 2 hours`);
      nextCheckDelayMs = BACKOFF_CONFIG.PROXY_BLOCKED_MS;
      isRetryable = true;
    } else if (error instanceof ScraperError) {
      if (error.code === 'FORBIDDEN' || error.code === 'CLOUDFLARE_BLOCKED') {
        nextCheckDelayMs = BACKOFF_CONFIG.FORBIDDEN_MS;
      }
      isRetryable = error.isRetryable;
    }
    
    console.error(`[PollSource][${jobId}] Error polling source ${source.id}:`, error);
    
    await prisma.seriesSource.update({
      where: { id: source.id },
      data: {
        last_checked_at: new Date(),
        failure_count: { increment: 1 },
        next_check_at: new Date(Date.now() + nextCheckDelayMs),
      }
    });

    if (isRetryable) {
      throw error;
    }
  }
}
