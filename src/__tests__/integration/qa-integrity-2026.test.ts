import { prisma } from '@/lib/prisma';
import { getClientIp } from '@/lib/api-utils';
import { runCleanupScheduler } from '@/workers/schedulers/cleanup.scheduler';
import { v4 as uuidv4 } from 'uuid';

describe('QA Hardening & Integrity Tests (2026)', () => {
  const testUserId = uuidv4();
  const testSeriesId = uuidv4();

  beforeAll(async () => {
    // Setup test data
    await prisma.user.create({
      data: {
        id: testUserId,
        email: `qa-test-${testUserId}@example.com`,
        username: `qa_tester_${testUserId.slice(0, 8)}`,
        xp: 0,
        level: 1,
      }
    });

    await prisma.series.create({
      data: {
        id: testSeriesId,
        title: 'QA Test Series',
        type: 'manga',
        status: 'ongoing',
      }
    });
  });

  afterAll(async () => {
    // Permanent cleanup via raw SQL to bypass soft-delete logic
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = '${testUserId}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM series WHERE id = '${testSeriesId}' OR title LIKE 'QA Test Series %'`);
  });

  describe('Prisma Soft Delete Extension', () => {
    it('should convert delete() into an update with deleted_at', async () => {
      const entryId = uuidv4();
      await prisma.libraryEntry.create({
        data: {
          id: entryId,
          user_id: testUserId,
          series_id: testSeriesId,
          source_url: `https://qa.com/${entryId}`,
          source_name: 'qa-source',
          status: 'reading',
        }
      });

      // Execute delete
      await prisma.libraryEntry.delete({ where: { id: entryId } });

      // Verify it still exists in DB but with deleted_at set (bypass extension via raw SQL)
      const rawResult: any = await prisma.$queryRawUnsafe(
        `SELECT deleted_at FROM library_entries WHERE id = '${entryId}'`
      );
      expect(rawResult[0].deleted_at).not.toBeNull();

      // Verify it is hidden from normal findUnique
      const hiddenEntry = await prisma.libraryEntry.findUnique({ where: { id: entryId } });
      expect(hiddenEntry).toBeNull();
    });

    it('should filter deleted records from count()', async () => {
      const entryId = uuidv4();
      const sId = uuidv4();
      
      // Create a unique series for this test to avoid (user, series) constraint
      await prisma.series.create({
        data: {
          id: sId,
          title: 'QA Test Series 2',
          type: 'manga',
        }
      });

      await prisma.libraryEntry.create({
        data: {
          id: entryId,
          user_id: testUserId,
          series_id: sId,
          source_url: `https://qa.com/${entryId}`,
          source_name: 'qa-source',
          status: 'reading',
          deleted_at: new Date() // Pre-deleted
        }
      });

      const count = await prisma.libraryEntry.count({
        where: { id: entryId }
      });
      expect(count).toBe(0);
    });

    it('should prevent updates to deleted records', async () => {
      const entryId = uuidv4();
      const sId = uuidv4();

      await prisma.series.create({
        data: {
          id: sId,
          title: 'QA Test Series 3',
          type: 'manga',
        }
      });

      await prisma.libraryEntry.create({
        data: {
          id: entryId,
          user_id: testUserId,
          series_id: sId,
          source_url: `https://qa.com/${entryId}`,
          source_name: 'qa-source',
          status: 'reading',
          deleted_at: new Date()
        }
      });

      // Attempt update should fail because our extension adds 'deleted_at: null' to where
      // and Prisma update throws P2025 if no record matches where clause
      let errorOccurred = false;
      try {
        await prisma.libraryEntry.update({
          where: { id: entryId },
          data: { status: 'completed' }
        });
      } catch (e) {
        errorOccurred = true;
      }
      expect(errorOccurred).toBe(true);
    });
  });

  describe('IP Spoofing Defense', () => {
    it('should prioritize x-real-ip over x-forwarded-for', () => {
      const mockRequest = {
        headers: new Headers({
          'x-real-ip': '1.2.3.4',
          'x-forwarded-for': 'spoofed_ip, 5.6.7.8'
        })
      } as unknown as Request;

      const ip = getClientIp(mockRequest);
      expect(ip).toBe('1.2.3.4');
    });

    it('should take the last IP from x-forwarded-for as most trusted', () => {
      const mockRequest = {
        headers: new Headers({
          'x-forwarded-for': 'spoofed_ip, 5.6.7.8'
        })
      } as unknown as Request;

      const ip = getClientIp(mockRequest);
      expect(ip).toBe('5.6.7.8');
    });
  });

  describe('Import Job Resilience', () => {
    it('should fail jobs stuck in "processing" state', async () => {
      const stuckJobId = uuidv4();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      // Create a stuck job using raw SQL
      await prisma.$executeRawUnsafe(`
        INSERT INTO import_jobs (id, user_id, source, status, total_items, processed_items, matched_items, failed_items, created_at)
        VALUES ('${stuckJobId}', '${testUserId}', 'mal', 'processing', 10, 0, 0, 0, '${twoHoursAgo.toISOString()}')
      `);

      // Run cleanup
      await runCleanupScheduler();

      // Verify status changed to failed
      const job = await prisma.importJob.findUnique({ where: { id: stuckJobId } });
      expect(job?.status).toBe('failed');
      expect(job?.error_log).toMatchObject({ error: 'Job timed out' });

      // Cleanup
      await prisma.$executeRawUnsafe(`DELETE FROM import_jobs WHERE id = '${stuckJobId}'`);
    });
  });
});
