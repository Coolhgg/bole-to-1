import { Queue, QueueOptions } from 'bullmq';
import { redisWorker, REDIS_KEY_PREFIX, redisMode } from './redis';

export const SYNC_SOURCE_QUEUE = 'sync-source';
export const CHECK_SOURCE_QUEUE = 'check-source';
export const NOTIFICATION_QUEUE = 'notifications';
export const NOTIFICATION_DELIVERY_QUEUE = 'notification-delivery';
export const NOTIFICATION_DELIVERY_PREMIUM_QUEUE = 'notification-delivery-premium';
export const NOTIFICATION_DIGEST_QUEUE = 'notification-digest';
export const CANONICALIZE_QUEUE = 'canonicalize';
export const REFRESH_COVER_QUEUE = 'refresh-cover';
export const CHAPTER_INGEST_QUEUE = 'chapter-ingest';
export const GAP_RECOVERY_QUEUE = 'gap-recovery';
export const SERIES_RESOLUTION_QUEUE = 'series-resolution';
export const IMPORT_QUEUE = 'import';
export const FEED_FANOUT_QUEUE = 'feed-fanout';
export const LATEST_FEED_QUEUE = 'latest-feed';
export const NOTIFICATION_TIMING_QUEUE = 'notification-timing';

/**
 * Queue options using the Worker Redis instance.
 * 
 * CRITICAL: BullMQ Queues and Workers MUST be on the same Redis instance.
 * Queues use Worker Redis because workers process jobs from this Redis.
 * 
 * Connection Balance Strategy:
 * - API Redis (redis-11509): Caching, rate limiting, search cache, heartbeat
 * - Worker Redis (redis-16672): BullMQ queues, workers, locks, scheduler
 * 
 * The queues share the `redisWorker` connection (not creating new ones).
 * Workers create their own blocking connections (unavoidable in BullMQ).
 */
const queueOptions: QueueOptions = {
  connection: redisWorker,
  prefix: REDIS_KEY_PREFIX,
};

console.log('[Queues] Redis mode: %s, using Worker Redis for BullMQ', redisMode);

// Singleton pattern for Next.js hot reload protection
const globalForQueues = globalThis as unknown as {
  queues: Record<string, Queue>;
};

if (!globalForQueues.queues) {
  globalForQueues.queues = {};
}

/**
 * Lazy-load helper to initialize queues only when needed.
 * This saves connections in the API process if only some queues are used.
 */
function getQueue(name: string, options: Partial<QueueOptions> = {}): Queue {
  if (globalForQueues.queues[name]) {
    return globalForQueues.queues[name];
  }

  console.log(`[Queues] Initializing queue: ${name}`);
  const queue = new Queue(name, {
    ...queueOptions,
    ...options,
  });

  globalForQueues.queues[name] = queue;
  return queue;
}

/**
 * Creates a proxy for a queue to delay its initialization until it's actually used.
 */
function createLazyQueue(name: string, options: Partial<QueueOptions> = {}): Queue {
  return new Proxy({} as Queue, {
    get(target, prop, receiver) {
      const queue = getQueue(name, options);
      const value = Reflect.get(queue, prop, receiver);
      return typeof value === 'function' ? value.bind(queue) : value;
    }
  });
}

// Exported lazy getters using Proxy
export const syncSourceQueue = createLazyQueue(SYNC_SOURCE_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 5000 }, 
  },
});

export const chapterIngestQueue = createLazyQueue(CHAPTER_INGEST_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 10000 },
  },
});

export const checkSourceQueue = createLazyQueue(CHECK_SOURCE_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 1000 },
  },
});

export const notificationQueue = createLazyQueue(NOTIFICATION_QUEUE, {
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 5000 },
  },
});

export const notificationDeliveryQueue = createLazyQueue(NOTIFICATION_DELIVERY_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 10000 },
  },
});

export const notificationDeliveryPremiumQueue = createLazyQueue(NOTIFICATION_DELIVERY_PREMIUM_QUEUE, {
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000, age: 3600 },
    removeOnFail: { count: 20000 },
  },
});

export const notificationDigestQueue = createLazyQueue(NOTIFICATION_DIGEST_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
  },
});

export const canonicalizeQueue = createLazyQueue(CANONICALIZE_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
  },
});

export const refreshCoverQueue = createLazyQueue(REFRESH_COVER_QUEUE, {
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 50, age: 3600 },
    removeOnFail: { count: 100, age: 86400 },
  },
});

export const gapRecoveryQueue = createLazyQueue(GAP_RECOVERY_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
  },
});

export const seriesResolutionQueue = createLazyQueue(SERIES_RESOLUTION_QUEUE, {
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: { count: 100, age: 86400 },
    removeOnFail: { count: 100, age: 604800 },
  },
});

export const importQueue = createLazyQueue(IMPORT_QUEUE, {
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100, age: 86400 },
    removeOnFail: { count: 100, age: 604800 },
  },
});

export const feedFanoutQueue = createLazyQueue(FEED_FANOUT_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 1000, age: 86400 },
  },
});

export const latestFeedQueue = createLazyQueue(LATEST_FEED_QUEUE, {
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 50, age: 3600 },
    removeOnFail: { count: 100, age: 86400 },
  },
});

export const notificationTimingQueue = createLazyQueue(NOTIFICATION_TIMING_QUEUE, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 1000, age: 86400 },
  },
});

/**
 * Gets the overall system health for notifications.
 */
export async function getNotificationSystemHealth(): Promise<{ 
  totalWaiting: number; 
  isOverloaded: boolean;
  isCritical: boolean;
  isRejected: boolean;
}> {
  try {
    const freeCounts = await notificationDeliveryQueue.getJobCounts('waiting');
    const premiumCounts = await notificationDeliveryPremiumQueue.getJobCounts('waiting');
    const totalWaiting = freeCounts.waiting + premiumCounts.waiting;

    return {
      totalWaiting,
      isOverloaded: totalWaiting > 10000,
      isCritical: totalWaiting > 50000,
      isRejected: totalWaiting > 100000,
    };
  } catch (error) {
    console.error('[Queue] Health check failed:', error);
    return { totalWaiting: 0, isOverloaded: false, isCritical: false, isRejected: false };
  }
}

/**
 * Checks if a specific queue is healthy based on a waiting threshold.
 */
export async function isQueueHealthy(queue: Queue, threshold: number): Promise<boolean> {
  const counts = await queue.getJobCounts('waiting');
  return counts.waiting < threshold;
}
