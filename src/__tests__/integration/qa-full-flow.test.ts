import { GET as searchGET } from '@/app/api/series/search/route';
import { POST as libraryPOST, GET as libraryGET } from '@/app/api/library/route';
import { GET as feedUpdatesGET } from '@/app/api/feed/updates/route';
import { NextRequest, NextResponse } from 'next/server';

// Mock Prisma globally
jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    series: { findUnique: jest.fn(), update: jest.fn() },
    chapter: { findMany: jest.fn(), count: jest.fn() },
    libraryEntry: { 
      findUnique: jest.fn(), 
      upsert: jest.fn(), 
      create: jest.fn(), 
      count: jest.fn(), 
      findMany: jest.fn(), 
      groupBy: jest.fn(),
      findFirst: jest.fn()
    },
    activity: { create: jest.fn() },
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn((cb) => (typeof cb === 'function' ? cb(require('@/lib/prisma').prisma) : cb)),
    $executeRaw: jest.fn(),
  },
  withRetry: jest.fn((fn) => fn()),
  isTransientError: jest.fn(() => false),
}));

import { prisma } from '@/lib/prisma';
import { createClient } from '@/lib/supabase/server';

// Mock Supabase Server Client
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

// Mock Supabase Admin Client
jest.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
  supabaseAdminRead: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

// Mock API Utils
jest.mock('@/lib/api-utils', () => ({
  checkRateLimit: jest.fn(() => Promise.resolve(true)),
  getClientIp: jest.fn(() => '127.0.0.1'),
  sanitizeInput: (s: string) => s,
  handleApiError: (e: any) => NextResponse.json({ error: e.message }, { status: e.status || e.statusCode || 500 }),
  ApiError: class extends Error { 
    statusCode: number; 
    code: string; 
    constructor(m: string, s: number, c: string) { 
      super(m); 
      this.statusCode = s; 
      this.code = c; 
    } 
  },
  ErrorCodes: { 
    RATE_LIMITED: 'RATE_LIMITED', 
    VALIDATION_ERROR: 'VALIDATION_ERROR', 
    UNAUTHORIZED: 'UNAUTHORIZED', 
    NOT_FOUND: 'NOT_FOUND', 
    BAD_REQUEST: 'BAD_REQUEST',
    CONFLICT: 'CONFLICT'
  },
  validateOrigin: jest.fn(),
  validateContentType: jest.fn(),
  validateJsonSize: jest.fn(() => Promise.resolve()),
  logSecurityEvent: jest.fn(() => Promise.resolve()),
  parsePaginationParams: jest.fn(() => ({ page: 1, limit: 20, offset: 0, cursor: null })),
  escapeILikePattern: (s: string) => s,
}));

// Mock Search Cache
jest.mock('@/lib/search-cache', () => ({
  getCachedSearchResult: jest.fn(() => Promise.resolve(null)),
  setCachedSearchResult: jest.fn(() => Promise.resolve()),
  checkPendingSearch: jest.fn(() => Promise.resolve(null)),
  markSearchPending: jest.fn(() => Promise.resolve()),
  clearPendingSearch: jest.fn(() => Promise.resolve()),
  waitForPendingSearch: jest.fn(() => Promise.resolve(null)),
  consumeSearchQuota: jest.fn(() => Promise.resolve({ allowed: true })),
  SEARCH_PRIORITY: { CRITICAL: 1, STANDARD: 3 },
}));

// Mock Catalog Tiers
jest.mock('@/lib/catalog-tiers', () => ({
  promoteSeriesTier: jest.fn(() => Promise.resolve()),
}));

// Mock Cover Resolver
jest.mock('@/lib/cover-resolver', () => ({
  getBestCoversBatch: jest.fn(() => Promise.resolve(new Map())),
  isValidCoverUrl: jest.fn(() => true),
}));

// Mock Redis
jest.mock('@/lib/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn() },
  waitForRedis: jest.fn(() => Promise.resolve(false)),
  areWorkersOnline: jest.fn(() => Promise.resolve(false)),
  REDIS_KEY_PREFIX: 'kenmei:test:',
}));

// Mock Queues
jest.mock('@/lib/queues', () => ({
  checkSourceQueue: { add: jest.fn(), getJob: jest.fn() },
  isQueueHealthy: jest.fn(() => Promise.resolve(true)),
}));

// Mock Analytics
jest.mock('@/lib/analytics', () => ({
  recordSearchEvent: jest.fn(),
}));

// Mock Search Utils
jest.mock('@/lib/search-utils', () => ({
  normalizeSearchQuery: (q: string) => q.toLowerCase().trim(),
  recordSearchIntent: jest.fn(),
  shouldEnqueueExternalSearch: jest.fn(() => Promise.resolve({ shouldEnqueue: false })),
  markQueryEnqueued: jest.fn(),
  markQueryDeferred: jest.fn(),
}));

// Mock Search Intent
jest.mock('@/lib/search-intent', () => ({
  detectSearchIntent: jest.fn(() => 'TITLE'),
}));

describe('QA Full Flow Integration Tests', () => {
  const mockUser = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.com' };
  const mockSeries = {
    id: '00000000-0000-0000-0000-000000000002',
    title: 'Test Series',
    catalog_tier: 'A',
    genres: ['Action', 'Adventure'],
    cover_url: 'https://example.com/cover.jpg',
    type: 'manga',
    status: 'ongoing',
    content_rating: 'safe',
    total_follows: 100,
    sources: [{
      id: '00000000-0000-0000-0000-000000000003',
      source_name: 'mangadex',
      source_url: 'https://mangadex.org/title/test',
      trust_score: 10
    }]
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Mock Supabase Auth
    (createClient as jest.Mock).mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      })),
    });

    // Mock Prisma
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: mockUser.id,
      subscription_tier: 'free',
      safe_browsing_mode: 'sfw',
      default_source: null,
      feed_last_seen_at: null,
    });

    (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([mockSeries]);
    (prisma.series.findUnique as jest.Mock).mockResolvedValue(mockSeries);
    (prisma.libraryEntry.create as jest.Mock).mockResolvedValue({ id: 'entry-id' });
    (prisma.libraryEntry.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.libraryEntry.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.libraryEntry.upsert as jest.Mock).mockResolvedValue({ id: 'upserted-id' });
    (prisma.activity.create as jest.Mock).mockResolvedValue({ id: 'activity-id' });
    (prisma.series.update as jest.Mock).mockResolvedValue(mockSeries);
    
    // Mock transaction
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return cb(prisma);
      return cb;
    });
  });

  describe('Search API', () => {
    it('should return search results for a valid query', async () => {
      const searchReq = new NextRequest('http://localhost/api/series/search?q=Test');
      const searchRes = await searchGET(searchReq);
      const searchData = await searchRes.json();

      expect(searchRes.status).toBe(200);
      expect(searchData.results).toBeDefined();
      expect(Array.isArray(searchData.results)).toBe(true);
    });

    it('should handle empty search results gracefully', async () => {
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
      
      const searchReq = new NextRequest('http://localhost/api/series/search?q=NonexistentSeries');
      const searchRes = await searchGET(searchReq);
      const searchData = await searchRes.json();

      expect(searchRes.status).toBe(200);
      expect(searchData.results).toEqual([]);
    });
  });

  describe('Library API', () => {
    it('should add a series to library successfully', async () => {
      const libraryReq = new NextRequest('http://localhost/api/library', {
        method: 'POST',
        body: JSON.stringify({ seriesId: mockSeries.id, status: 'reading' }),
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost'
        }
      });
      
      const libraryRes = await libraryPOST(libraryReq);
      const libraryData = await libraryRes.json();
      
      expect(libraryRes.status).toBe(201);
      expect(libraryData.id).toBeDefined();
    });

    it('should reject invalid series ID format', async () => {
      const libraryReq = new NextRequest('http://localhost/api/library', {
        method: 'POST',
        body: JSON.stringify({ seriesId: 'invalid-uuid', status: 'reading' }),
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost'
        }
      });
      
      const libraryRes = await libraryPOST(libraryReq);
      
      expect(libraryRes.status).toBe(400);
    });

    it('should return 404 for non-existent series', async () => {
      (prisma.series.findUnique as jest.Mock).mockResolvedValue(null);

      const libraryReq = new NextRequest('http://localhost/api/library', {
        method: 'POST',
        body: JSON.stringify({ seriesId: '00000000-0000-0000-0000-000000000099', status: 'reading' }),
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost'
        }
      });
      
      const libraryRes = await libraryPOST(libraryReq);
      
      expect(libraryRes.status).toBe(404);
    });
  });

  describe('Feed Updates API', () => {
    it('should return empty updates when no library entries exist', async () => {
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
      (prisma.libraryEntry.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.chapter.findMany as jest.Mock).mockResolvedValue([]);

      const feedReq = new NextRequest('http://localhost/api/feed/updates');
      const feedRes = await feedUpdatesGET(feedReq);
      const feedData = await feedRes.json();

      expect(feedRes.status).toBe(200);
      expect(feedData.updates).toEqual([]);
      expect(feedData.has_more).toBe(false);
    });

    it('should require authentication', async () => {
      (createClient as jest.Mock).mockResolvedValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }),
        },
      });

      const feedReq = new NextRequest('http://localhost/api/feed/updates');
      const feedRes = await feedUpdatesGET(feedReq);

      expect(feedRes.status).toBe(401);
    });
  });

  describe('End-to-End Flow: Search -> Add to Library', () => {
    it('should complete the full flow successfully', async () => {
      // 1. Search for a series
      const searchReq = new NextRequest('http://localhost/api/series/search?q=Test');
      const searchRes = await searchGET(searchReq);
      const searchData = await searchRes.json();

      expect(searchRes.status).toBe(200);
      expect(searchData.results.length).toBeGreaterThanOrEqual(1);

      // 2. Add the found series to library
      const foundSeriesId = searchData.results[0].id;
      
      const libraryReq = new NextRequest('http://localhost/api/library', {
        method: 'POST',
        body: JSON.stringify({ seriesId: foundSeriesId, status: 'reading' }),
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost'
        }
      });
      
      const libraryRes = await libraryPOST(libraryReq);
      const libraryData = await libraryRes.json();
      
      expect(libraryRes.status).toBe(201);
      expect(libraryData.id).toBeDefined();
      
      // Verify that follow count was incremented
      expect(prisma.series.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: foundSeriesId },
          data: { total_follows: { increment: 1 } }
        })
      );
    });
  });
});

describe('Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject requests without authentication for protected endpoints', async () => {
    (createClient as jest.Mock).mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
    });

    const libraryReq = new NextRequest('http://localhost/api/library', {
      method: 'POST',
      body: JSON.stringify({ seriesId: '00000000-0000-0000-0000-000000000002', status: 'reading' }),
      headers: {
        'content-type': 'application/json',
        'origin': 'http://localhost'
      }
    });
    
    const libraryRes = await libraryPOST(libraryReq);
    
    expect(libraryRes.status).toBe(401);
  });
});
