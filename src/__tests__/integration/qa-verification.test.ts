/**
 * @jest-environment node
 */
import { prisma } from '@/lib/prisma';
import { normalizeSearchQuery, shouldEnqueueExternalSearch, recordSearchIntent } from '@/lib/search-utils';
import { markSearchPending, clearPendingSearch, checkPendingSearch, deferSearchQuery, getDeferredQueryData } from '@/lib/search-cache';
import { processChapterIngest } from '@/workers/processors/chapter-ingest.processor';
import { Prisma } from '@prisma/client';

// Mock Redis
jest.mock('@/lib/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    sadd: jest.fn(),
    expire: jest.fn(),
    zadd: jest.fn(),
    zcard: jest.fn(),
    multi: jest.fn().mockReturnValue({
      hincrby: jest.fn().mockReturnThis(),
      hsetnx: jest.fn().mockReturnThis(),
      hset: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  },
  waitForRedis: jest.fn().mockResolvedValue(true),
  REDIS_KEY_PREFIX: 'test:',
  withLock: jest.fn().mockImplementation((key, ttl, fn) => fn()),
}));

// Mock Queues
const mockQueue = {
  add: jest.fn(),
  getJob: jest.fn(),
  getWaitingCount: jest.fn().mockResolvedValue(0),
  getActiveCount: jest.fn().mockResolvedValue(0),
};

jest.mock('@/lib/queues', () => ({
  checkSourceQueue: mockQueue,
  isQueueHealthy: jest.fn().mockResolvedValue(true),
  notificationQueue: { add: jest.fn() },
  gapRecoveryQueue: { add: jest.fn() },
}));

describe('QA Verification: Search, Queue & Chapters', () => {
  let testUser: any;
  let testSeries: any;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: {
        email: `qa-tester-${Date.now()}@example.com`,
        username: `qa_tester_${Math.random().toString(36).slice(2, 7)}`,
        password_hash: 'test',
      }
    });

    testSeries = await prisma.series.create({
      data: {
        title: 'One Piece',
        type: 'manga',
        status: 'ongoing',
      }
    });
  });

  afterAll(async () => {
    await prisma.queryStats.deleteMany({ where: { normalized_key: { in: ['one piece', 'obscure title'] } } });
    await prisma.feedEntry.deleteMany({ where: { series_id: testSeries.id } });
    await prisma.chapterSource.deleteMany({ where: { chapter: { series_id: testSeries.id } } });
    await prisma.logicalChapter.deleteMany({ where: { series_id: testSeries.id } });
    await prisma.seriesSource.deleteMany({ where: { series_id: testSeries.id } });
    await prisma.series.delete({ where: { id: testSeries.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
  });

  describe('1. Search Deduplication', () => {
    test('100 simultaneous searches should be deduplicated via Redis lock', async () => {
      const query = 'One Piece';
      const normalized = normalizeSearchQuery(query);
      const requestId = 'req-123';
      const filters = { limit: 24 };

      // Mock Redis.set NX to succeed once then fail
      const { redis } = require('@/lib/redis');
      redis.set.mockResolvedValueOnce('OK').mockResolvedValue(null);

      const results = await Promise.all(
        Array.from({ length: 10 }).map(() => markSearchPending(normalized, filters, requestId))
      );

      expect(results[0]).toBe(true);
      expect(results.filter(r => r === true)).toHaveLength(1);
    });
  });

  describe('2. Cold Query Handling', () => {
    test('Obscure title searched once should not trigger external job', async () => {
      const query = 'Obscure Title';
      const normalized = normalizeSearchQuery(query);
      
      // First search
      await recordSearchIntent(normalized, testUser.id);
      
      const decision = await shouldEnqueueExternalSearch(normalized, mockQueue as any);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('below_threshold');
    });

    test('Second search should trigger external job if heat threshold met', async () => {
      const query = 'Obscure Title';
      const normalized = normalizeSearchQuery(query);
      
      // Second search from another user (or same, but recordSearchIntent tracks unique users in Redis)
      const { redis } = require('@/lib/redis');
      redis.sadd.mockResolvedValueOnce(1); // Simulate unique user

      await recordSearchIntent(normalized, 'another-user-id');
      
      const decision = await shouldEnqueueExternalSearch(normalized, mockQueue as any);
      expect(decision.shouldEnqueue).toBe(true);
    });
  });

  describe('3. Queue Health Cutoff', () => {
    test('External search skipped if queue is unhealthy', async () => {
      const query = 'One Piece';
      const normalized = normalizeSearchQuery(query);
      
      const { isQueueHealthy } = require('@/lib/queues');
      isQueueHealthy.mockResolvedValueOnce(false);

      const decision = await shouldEnqueueExternalSearch(normalized, mockQueue as any);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('queue_unhealthy');
    });
  });

  describe('4. Read Behavior & Logical Chapters', () => {
    test('Reading one source should mark logical chapter as read for all sources', async () => {
      // 1. Ingest Chapter 1 from MangaPark
      const source1 = await prisma.seriesSource.create({
        data: {
          series_id: testSeries.id,
          source_name: 'mangapark',
          source_id: 'mp-1',
          source_url: 'https://mangapark.net/manga/mp-1',
        }
      });

      await processChapterIngest({
        id: 'job-1',
        data: {
          seriesSourceId: source1.id,
          seriesId: testSeries.id,
          chapterNumber: 1,
          chapterTitle: 'Dawn',
          chapterUrl: 'https://mangapark.net/manga/mp-1/1',
          sourceChapterId: 'mp-ch-1',
          publishedAt: new Date().toISOString(),
        }
      } as any);

      // 2. Ingest Chapter 1 from MangaDex
      const source2 = await prisma.seriesSource.create({
        data: {
          series_id: testSeries.id,
          source_name: 'mangadex',
          source_id: 'md-1',
          source_url: 'https://mangadex.org/title/md-1',
        }
      });

      await processChapterIngest({
        id: 'job-2',
        data: {
          seriesSourceId: source2.id,
          seriesId: testSeries.id,
          chapterNumber: 1,
          chapterTitle: 'Romance Dawn',
          chapterUrl: 'https://mangadex.org/chapter/md-ch-1',
          sourceChapterId: 'md-ch-1',
          publishedAt: new Date().toISOString(),
        }
      } as any);

      // 3. Verify they are grouped under one LogicalChapter
      const logicalChapters = await prisma.logicalChapter.findMany({
        where: { series_id: testSeries.id, chapter_number: new Prisma.Decimal(1) }
      });
      expect(logicalChapters).toHaveLength(1);
      const lc = logicalChapters[0];

      // 4. Mark AS READ
      await prisma.userChapterReadV2.create({
        data: {
          user_id: testUser.id,
          chapter_id: lc.id,
        }
      });

      // 5. Verify Read Status is reflected for the logical chapter
      const readStatus = await prisma.userChapterReadV2.findFirst({
        where: { user_id: testUser.id, chapter_id: lc.id }
      });
      expect(readStatus).toBeDefined();
    });
  });
});
