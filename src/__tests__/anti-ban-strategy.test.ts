import { normalizeSearchQuery, shouldEnqueueExternalSearch } from '../lib/search-utils';
import { SYNC_INTERVALS_BY_TIER } from '../workers/schedulers/master.scheduler';
import { prisma } from '../lib/prisma';
import { Queue } from 'bullmq';

describe('Anti-Ban Strategy QA', () => {
  describe('Search Storm Protection', () => {
    let mockQueue: any;

    beforeEach(() => {
      mockQueue = {
        getJob: jest.fn(),
        getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
      } as any;
    });

    it('should normalize queries consistently', () => {
      const q1 = '  One Piece!  ';
      const q2 = 'one piece';
      expect(normalizeSearchQuery(q1)).toBe(normalizeSearchQuery(q2));
    });

    it('should NOT enqueue if below threshold', async () => {
      // Create fresh query stats with 0 searches
      const normalizedKey = 'test-query-' + Date.now();
      
      const decision = await shouldEnqueueExternalSearch(normalizedKey, mockQueue);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('below_threshold');
    });

    it('should NOT enqueue if within 30s window', async () => {
      const normalizedKey = 'test-cooldown-' + Date.now();
      
      // Simulate existing stats meeting threshold but with recent enqueue
      await prisma.queryStats.create({
        data: {
          normalized_key: normalizedKey,
          total_searches: 10,
          last_enqueued_at: new Date(), // Just now
        }
      });

      const decision = await shouldEnqueueExternalSearch(normalizedKey, mockQueue);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('cooldown');
    });

    it('should NOT enqueue if job already active in queue', async () => {
      const normalizedKey = 'test-active-' + Date.now();
      
      await prisma.queryStats.create({
        data: {
          normalized_key: normalizedKey,
          total_searches: 10,
          last_enqueued_at: new Date(Date.now() - 60000), // 60s ago (outside cooldown)
        }
      });

      mockQueue.getJob.mockResolvedValue({
        getState: () => Promise.resolve('active')
      });

      const decision = await shouldEnqueueExternalSearch(normalizedKey, mockQueue);
      expect(decision.shouldEnqueue).toBe(false);
      expect(decision.reason).toBe('active_job');
    });
  });

  describe('Tier-Based Polling', () => {
    it('should have correct intervals for Tier A', () => {
      expect(SYNC_INTERVALS_BY_TIER.A.HOT).toBe(8 * 60 * 1000); // 8 mins
    });

    it('should exclude Tier C from intervals', () => {
      // @ts-expect-error - Verification that C is not in the config used by master.scheduler
      expect(SYNC_INTERVALS_BY_TIER.C).toBeUndefined();
    });
  });
});
