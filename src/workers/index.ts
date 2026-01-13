import 'dotenv/config';
import { Worker } from 'bullmq';

// Ensure listeners are only added once to prevent MaxListenersExceededWarning
// We do this at the very top before any other logic to ensure idempotency during HMR
if (!(global as any)._workerListenersAdded) {
    // Clean up any existing listeners if they were somehow added
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    
    process.on('SIGTERM', () => {
        console.log('[Workers] SIGTERM received');
        // @ts-expect-error - shutdown is defined below
        shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
        console.log('[Workers] SIGINT received');
        // @ts-expect-error - shutdown is defined below
        shutdown('SIGINT');
    });
    (global as any)._workerListenersAdded = true;
    console.log('[Workers] Process listeners initialized');
}

import { 
  redisWorker, 
  disconnectRedis, 
  REDIS_KEY_PREFIX, 
  setWorkerHeartbeat, 
  redisApi, 
  waitForRedis,
  schedulerRedis,
  getConnectionStats,
  redisConnection
} from '@/lib/redis';
import { 
    SYNC_SOURCE_QUEUE, CHECK_SOURCE_QUEUE, NOTIFICATION_QUEUE, 
      NOTIFICATION_DELIVERY_QUEUE, NOTIFICATION_DELIVERY_PREMIUM_QUEUE, NOTIFICATION_DIGEST_QUEUE,
        CANONICALIZE_QUEUE, REFRESH_COVER_QUEUE, CHAPTER_INGEST_QUEUE, GAP_RECOVERY_QUEUE,
          SERIES_RESOLUTION_QUEUE, IMPORT_QUEUE, FEED_FANOUT_QUEUE, LATEST_FEED_QUEUE, NOTIFICATION_TIMING_QUEUE,
          syncSourceQueue, checkSourceQueue, notificationQueue,
          notificationDeliveryQueue, notificationDeliveryPremiumQueue, notificationDigestQueue,
          canonicalizeQueue, refreshCoverQueue, chapterIngestQueue, gapRecoveryQueue,
          seriesResolutionQueue, importQueue, feedFanoutQueue, latestFeedQueue, notificationTimingQueue,
          getNotificationSystemHealth
        } from '@/lib/queues';
import { processPollSource } from './processors/poll-source.processor';
import { processChapterIngest } from './processors/chapter-ingest.processor';
import { processCheckSource } from './processors/check-source.processor';
import { processNotification } from './processors/notification.processor';
import { processNotificationDelivery } from './processors/notification-delivery.processor';
import { processNotificationDigest } from './processors/notification-digest.processor';
import { processCanonicalize } from './processors/canonicalize.processor';
import { processRefreshCover } from './processors/refresh-cover.processor';
import { processGapRecovery } from './processors/gap-recovery.processor';
import { processResolution } from './processors/resolution.processor';
import { processImport } from './processors/import.processor';
import { processFeedFanout } from './processors/feed-fanout.processor';
import { processLatestFeed } from './processors/latest-feed.processor';
import { processNotificationTiming } from './processors/notification-timing.processor';
import { runMasterScheduler } from './schedulers/master.scheduler';


import { initDNS } from '@/lib/dns-init';
import { logWorkerFailure, wrapWithDLQ } from '@/lib/api-utils';

// Initialize DNS servers (Google DNS fallback) to fix ENOTFOUND issues
initDNS();

console.log('[Workers] Starting...');

// Global process guards
process.on('uncaughtException', (error) => {
  console.error('[Workers] Uncaught Exception:', error);
  shutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Workers] Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection').catch(() => process.exit(1));
});

// Worker Initialization using Dedicated Worker Redis
let canonicalizeWorker: Worker | null = null;
let pollSourceWorker: Worker | null = null;
let chapterIngestWorker: Worker | null = null;
let checkSourceWorker: Worker | null = null;
let notificationWorker: Worker | null = null;
let notificationDeliveryWorker: Worker | null = null;
let notificationDeliveryPremiumWorker: Worker | null = null;
let notificationDigestWorker: Worker | null = null;
let refreshCoverWorker: Worker | null = null;
let gapRecoveryWorker: Worker | null = null;
let resolutionWorker: Worker | null = null;
let importWorker: Worker | null = null;
let feedFanoutWorker: Worker | null = null;
let latestFeedWorker: Worker | null = null;
let notificationTimingWorker: Worker | null = null;

function setupWorkerListeners(worker: Worker, name: string) {
  worker.on('completed', (job) => console.log(`[${name}] Job ${job.id} completed`));
  worker.on('active', (job) => console.log(`[${name}] Job ${job.id} started`));
  worker.on('failed', async (job, err) => {
    console.error(`[${name}] Job ${job?.id} failed:`, err.message);
    
    // DLQ Implementation: wrapWithDLQ handles logging to DB if job has exhausted all retries
    // No need to log here to avoid duplicates
  });
}

function initWorkers() {
  console.log('[Workers] Initializing worker instances...');
  
    canonicalizeWorker = new Worker(
      CANONICALIZE_QUEUE,
      wrapWithDLQ(CANONICALIZE_QUEUE, processCanonicalize),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 2,
      }
    );
    setupWorkerListeners(canonicalizeWorker, 'Canonicalize');

    pollSourceWorker = new Worker(
      SYNC_SOURCE_QUEUE,
      wrapWithDLQ(SYNC_SOURCE_QUEUE, processPollSource),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 20,
        limiter: {
          max: 10,
          duration: 1000,
        },
      }
    );
    setupWorkerListeners(pollSourceWorker, 'PollSource');

    chapterIngestWorker = new Worker(
      CHAPTER_INGEST_QUEUE,
      wrapWithDLQ(CHAPTER_INGEST_QUEUE, processChapterIngest),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 10,
      }
    );
    setupWorkerListeners(chapterIngestWorker, 'ChapterIngest');

    checkSourceWorker = new Worker(
      CHECK_SOURCE_QUEUE,
      wrapWithDLQ(CHECK_SOURCE_QUEUE, processCheckSource),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 2,
        limiter: {
          max: 3,
          duration: 1000,
        },
      }
    );
    setupWorkerListeners(checkSourceWorker, 'CheckSource');

    notificationWorker = new Worker(
      NOTIFICATION_QUEUE,
      wrapWithDLQ(NOTIFICATION_QUEUE, processNotification),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 3,
      }
    );
    setupWorkerListeners(notificationWorker, 'Notification');

    notificationDeliveryWorker = new Worker(
      NOTIFICATION_DELIVERY_QUEUE,
      wrapWithDLQ(NOTIFICATION_DELIVERY_QUEUE, processNotificationDelivery),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 5,
      }
    );
    setupWorkerListeners(notificationDeliveryWorker, 'NotificationDelivery');

    notificationDeliveryPremiumWorker = new Worker(
      NOTIFICATION_DELIVERY_PREMIUM_QUEUE,
      wrapWithDLQ(NOTIFICATION_DELIVERY_PREMIUM_QUEUE, processNotificationDelivery),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 15,
        limiter: {
          max: 1000,
          duration: 60000,
        },
      }
    );
    setupWorkerListeners(notificationDeliveryPremiumWorker, 'NotificationDeliveryPremium');

    notificationDigestWorker = new Worker(
      NOTIFICATION_DIGEST_QUEUE,
      wrapWithDLQ(NOTIFICATION_DIGEST_QUEUE, processNotificationDigest),
      { 
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 1,
      }
    );
    setupWorkerListeners(notificationDigestWorker, 'NotificationDigest');

    refreshCoverWorker = new Worker(
      REFRESH_COVER_QUEUE,
      wrapWithDLQ(REFRESH_COVER_QUEUE, processRefreshCover),
      {
        connection: redisConnection,
        prefix: REDIS_KEY_PREFIX,
        concurrency: 5,
        limiter: {
          max: 5,
          duration: 1000,
        },
      }
    );
    setupWorkerListeners(refreshCoverWorker, 'RefreshCover');

      gapRecoveryWorker = new Worker(
        GAP_RECOVERY_QUEUE,
        wrapWithDLQ(GAP_RECOVERY_QUEUE, processGapRecovery),
        {
          connection: redisConnection,
          prefix: REDIS_KEY_PREFIX,
          concurrency: 1,
        }
      );
      setupWorkerListeners(gapRecoveryWorker, 'GapRecovery');

        resolutionWorker = new Worker(
          SERIES_RESOLUTION_QUEUE,
          wrapWithDLQ(SERIES_RESOLUTION_QUEUE, processResolution),
          {
            connection: redisConnection,
            prefix: REDIS_KEY_PREFIX,
            concurrency: 2,
            limiter: {
              max: 5,
              duration: 1000,
            },
          }
        );

        if (resolutionWorker) {
          setupWorkerListeners(resolutionWorker, 'Resolution');
        }

        importWorker = new Worker(
          IMPORT_QUEUE,
          wrapWithDLQ(IMPORT_QUEUE, processImport),
          {
            connection: redisConnection,
            prefix: REDIS_KEY_PREFIX,
            concurrency: 2,
          }
        );
        setupWorkerListeners(importWorker, 'Import');

          feedFanoutWorker = new Worker(
            FEED_FANOUT_QUEUE,
            wrapWithDLQ(FEED_FANOUT_QUEUE, processFeedFanout),
            { 
              connection: redisConnection,
              prefix: REDIS_KEY_PREFIX,
              concurrency: 5,
            }
          );
          setupWorkerListeners(feedFanoutWorker, 'FeedFanout');

            latestFeedWorker = new Worker(
              LATEST_FEED_QUEUE,
              wrapWithDLQ(LATEST_FEED_QUEUE, processLatestFeed),
              { 
                connection: redisConnection,
                prefix: REDIS_KEY_PREFIX,
                concurrency: 1, // Discovery is low-volume
              }
            );
            setupWorkerListeners(latestFeedWorker, 'LatestFeed');

            notificationTimingWorker = new Worker(
              NOTIFICATION_TIMING_QUEUE,
              wrapWithDLQ(NOTIFICATION_TIMING_QUEUE, processNotificationTiming),
              { 
                connection: redisConnection,
                prefix: REDIS_KEY_PREFIX,
                concurrency: 1,
              }
            );
            setupWorkerListeners(notificationTimingWorker, 'NotificationTiming');

          console.log('[Workers] Worker instances initialized and listening');
}


// Heartbeat interval
const HEARTBEAT_INTERVAL = 10 * 1000; // 10s
let heartbeatInterval: NodeJS.Timeout | null = null;
let isOperational = false;
let isShuttingDown = false;

async function getSystemHealth() {
  try {
    // If not operational (no global lock yet), return minimal health info to save connections
    if (!isOperational) {
      return {
        status: 'starting',
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        timestamp: Date.now()
      };
    }

    const [notificationHealth, syncCounts, ingestCounts, resolutionCounts, importCounts, fanoutCounts, latestCounts] = await Promise.all([
      getNotificationSystemHealth(),
      syncSourceQueue.getJobCounts('waiting', 'active'),
      chapterIngestQueue.getJobCounts('waiting', 'active'),
      seriesResolutionQueue.getJobCounts('waiting', 'active'),
      importQueue.getJobCounts('waiting', 'active'),
      feedFanoutQueue.getJobCounts('waiting', 'active'),
      latestFeedQueue.getJobCounts('waiting', 'active'),
    ]);

    return {
      status: notificationHealth.isCritical ? 'unhealthy' : 'healthy',
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      queues: {
        notifications: notificationHealth,
        sync: syncCounts,
        ingest: ingestCounts,
        resolution: resolutionCounts,
        import: importCounts,
        fanout: fanoutCounts,
        latest: latestCounts,
      },
      timestamp: Date.now()
    };
  } catch (err) {
    console.error('[Workers] Failed to get system health:', err);
    return {
      status: 'error',
      timestamp: Date.now()
    };
  }
}

async function startHeartbeat() {
  const initialHealth = await getSystemHealth();
  await setWorkerHeartbeat(initialHealth);
  console.log('[Workers] Initial heartbeat sent');
  
  heartbeatInterval = setInterval(async () => {
    try {
      const health = await getSystemHealth();
      await setWorkerHeartbeat(health);
      console.log('[Workers] Heartbeat sent');
    } catch (error) {
      console.error('[Workers] Failed to send heartbeat:', error);
    }
  }, HEARTBEAT_INTERVAL);
}

// Scheduler interval
const SCHEDULER_INTERVAL = 5 * 60 * 1000;
const SCHEDULER_LOCK_KEY = `${REDIS_KEY_PREFIX}scheduler:lock`;
const SCHEDULER_LOCK_TTL = 360; 
const WORKER_GLOBAL_LOCK_KEY = `${REDIS_KEY_PREFIX}workers:global`;
const WORKER_GLOBAL_LOCK_TTL = 60;

let schedulerInterval: NodeJS.Timeout | null = null;
let globalLockHeartbeat: NodeJS.Timeout | null = null;

async function acquireGlobalLock(): Promise<boolean> {
  try {
    if (!redisWorker || typeof redisWorker.set !== 'function') {
      console.error('[Workers] Redis client not ready for global lock acquisition');
      return false;
    }
    const result = await redisWorker.set(WORKER_GLOBAL_LOCK_KEY, process.pid.toString(), 'EX', WORKER_GLOBAL_LOCK_TTL, 'NX');
    if (result === 'OK') {
      globalLockHeartbeat = setInterval(async () => {
        try {
          await redisWorker.expire(WORKER_GLOBAL_LOCK_KEY, WORKER_GLOBAL_LOCK_TTL);
        } catch (error) {
          console.error('[Workers] Failed to extend global lock TTL:', error);
        }
      }, (WORKER_GLOBAL_LOCK_TTL / 2) * 1000);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[Workers] Failed to acquire global lock:', error);
    return false;
  }
}

async function acquireSchedulerLock(client: any): Promise<boolean> {
  try {
    if (!client || typeof client.set !== 'function') {
      console.error('[Scheduler] Redis client not ready for scheduler lock acquisition');
      return false;
    }
    const result = await client.set(SCHEDULER_LOCK_KEY, process.pid.toString(), 'EX', SCHEDULER_LOCK_TTL, 'NX');
    return result === 'OK';
  } catch (error) {
    console.error('[Scheduler] Failed to acquire lock:', error);
    return false;
  }
}

async function startScheduler() {
  console.log('[Scheduler] Initializing master scheduler loop...');
  
  try {
    // USE redisWorker instead of schedulerRedis to save one connection
    const ready = await waitForRedis(redisWorker, 5000);
    if (!ready) {
      console.error('[Scheduler] Failed to connect to Redis for Scheduler. Loop aborted.');
      return;
    }

    console.log('[Scheduler] Starting master scheduler loop on redisWorker...');
    
    const runScheduler = async () => {
      const hasLock = await acquireSchedulerLock(redisWorker);
      if (hasLock) {
        try {
          await runMasterScheduler();
        } catch (error) {
          console.error('[Scheduler] Error in master scheduler:', error);
        }
      }
    };

    await runScheduler();
    schedulerInterval = setInterval(runScheduler, SCHEDULER_INTERVAL);
  } catch (err) {
    console.error('[Scheduler] Initialization failed:', err);
  }
}

async function clearStaleLocks() {
  console.log('[Workers] Checking for stale locks...');
  try {
    const heartbeatKey = `${REDIS_KEY_PREFIX}workers:heartbeat`;
    const heartbeat = await redisApi.get(heartbeatKey);
    
    let isHealthy = false;
    let staleReason = '';

    if (heartbeat) {
      const data = JSON.parse(heartbeat);
      const age = Date.now() - data.timestamp;
      isHealthy = age < 45000;
      if (!isHealthy) staleReason = `Heartbeat is stale (${Math.round(age/1000)}s old)`;
    } else {
      isHealthy = false;
      staleReason = 'No heartbeat found';
    }

    if (!isHealthy) {
      console.log(`[Workers] ${staleReason}. Resetting global locks to allow recovery...`);
      
      // Atomic deletion of multiple lock keys
      const keysToClear = [
        WORKER_GLOBAL_LOCK_KEY,
        SCHEDULER_LOCK_KEY,
        `${REDIS_KEY_PREFIX}lock:scheduler:master`
      ];
      
      const results = await Promise.all(keysToClear.map(key => redisWorker.del(key)));
      const clearedCount = results.reduce((acc, val) => acc + (val || 0), 0);
      
      console.log(`[Workers] Cleanup complete. Cleared ${clearedCount} lock keys.`);
    } else {
      console.log('[Workers] Active worker session detected via healthy heartbeat');
    }
  } catch (error) {
    console.error('[Workers] Failed to check/clear stale locks:', error);
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {
  try {
    // Wait for Redis to be ready before doing anything
    console.log('[Workers] Waiting for Redis connection...');
    const redisReady = await Promise.all([
      waitForRedis(redisApi, 5000),
      waitForRedis(redisWorker, 5000)
    ]);

    if (!redisReady.every(Boolean)) {
      console.error('[Workers] Failed to connect to Redis within timeout. Exiting.');
      process.exit(1);
    }

    const stats = await getConnectionStats();
    if (stats) {
      console.log('[Workers] Redis Connection Stats:', JSON.stringify(stats, null, 2));
    }

    // Start heartbeat IMMEDIATELY so the API knows we are alive and trying to start
    await startHeartbeat();

    let retryCount = 0;
    let hasGlobalLock = false;
    const baseDelay = 2000; 
    const maxDelay = 30000; 

    while (!hasGlobalLock) {
      // Clear stale locks periodically to recover from crashes
      if (retryCount === 0 || retryCount % 5 === 0) {
        await clearStaleLocks();
      }

      hasGlobalLock = await acquireGlobalLock();
      
      if (!hasGlobalLock) {
        const delay = Math.min(baseDelay * Math.pow(1.5, retryCount), maxDelay);
        console.warn(`[Workers] Global lock held by another instance. Retrying in ${Math.round(delay)}ms... (Attempt ${retryCount + 1})`);
        await sleep(delay);
        retryCount++;
        
        // Safety break if we've been trying for too long (e.g. 10 minutes)
        if (retryCount > 100) {
          console.error('[Workers] Could not acquire global lock after 100 attempts. Exiting.');
          process.exit(1);
        }
      }
    }

    console.log('[Workers] Acquired global lock on dedicated Redis');

    // Re-enabled all workers for full system functionality
    initWorkers();
    
    isOperational = true;
    
    // Start the scheduler
    await startScheduler();
    
    console.log('[Workers] Fully operational');

    // Monitor for fatal Redis connection loss
    redisWorker.on('end', () => {
      console.error('[Workers] Redis connection closed permanently');
      shutdown('redis_end').catch(() => process.exit(1));
    });

    redisWorker.on('error', (err) => {
      console.error('[Workers] Redis Connection Error:', err);
    });

    redisWorker.on('error', (err) => {
      console.error('[Workers] Redis Connection Error:', err);
    });

    } catch (error) {
      console.error('[Workers] FATAL STARTUP ERROR:', error);
      if (error instanceof Error) {
        console.error('[Workers] Stack trace:', error.stack);
      }
      await shutdown('bootstrap_failure');
    }
}

// Redis Self-Check
let failedPings = 0;
const pingInterval = setInterval(async () => {
  try {
    const redisPing = await redisWorker.ping();
    if (redisPing === 'PONG') {
      failedPings = 0;
      return;
    }
    failedPings++;
  } catch (error) {
    failedPings++;
  }

  if (failedPings >= 3) {
    console.error('[Workers] Dedicated Redis unavailable – exiting');
    process.exit(1);
  }
}, 10000);

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`[Workers] Received ${signal}, shutting down gracefully...`);
  
  // Clean up intervals
  clearInterval(pingInterval);

  // Hard timeout for shutdown to prevent zombie processes
  const forceExit = setTimeout(() => {
    console.error('[Workers] Shutdown timed out, forcing exit');
    process.exit(1);
  }, 25000);

  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (globalLockHeartbeat) clearInterval(globalLockHeartbeat);
  if (schedulerInterval) clearInterval(schedulerInterval);

  try {
    if (isOperational) {
      await redisWorker.del(WORKER_GLOBAL_LOCK_KEY);
      console.log('[Workers] Global lock released');
    }
  } catch (error) {
    console.error('[Workers] Failed to release global lock:', error);
  }

    // Close workers first to stop processing new jobs
    console.log('[Workers] Closing worker instances...');
          const workers = [
            canonicalizeWorker, pollSourceWorker, chapterIngestWorker, 
            checkSourceWorker, notificationWorker, notificationDeliveryWorker,
            notificationDeliveryPremiumWorker, notificationDigestWorker, 
            refreshCoverWorker, gapRecoveryWorker, resolutionWorker, importWorker,
            feedFanoutWorker, latestFeedWorker, notificationTimingWorker
          ].filter(Boolean);

          await Promise.all(workers.map(w => w?.close()));

          // Close queue connections
          console.log('[Workers] Closing queue connections...');
          const queues = [
            syncSourceQueue, checkSourceQueue, notificationQueue,
            notificationDeliveryQueue, notificationDeliveryPremiumQueue, notificationDigestQueue,
            canonicalizeQueue, refreshCoverQueue, chapterIngestQueue, gapRecoveryQueue,
            seriesResolutionQueue, importQueue, feedFanoutQueue, latestFeedQueue, notificationTimingQueue
          ];

        await Promise.all(queues.map(q => q.close()));


  await disconnectRedis();
  
  if (schedulerRedis) {
    try {
      await schedulerRedis.quit();
    } catch {
      schedulerRedis.disconnect();
    }
    console.log('[Scheduler] Dedicated client disconnected');
  }
  
  clearTimeout(forceExit);
  console.log('[Workers] Shutdown complete');
  
  // Remove listeners before exiting to prevent memory leaks if process stays alive
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  
    process.exit(0);
}

start().catch(error => {

  console.error('[Workers] Fatal error during startup:', error);
  process.exit(1);
});
