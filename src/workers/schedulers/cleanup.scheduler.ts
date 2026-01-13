import { prisma } from '@/lib/prisma';

/**
 * Cleanup Scheduler
 * 1. Identifies and fails stuck jobs
 * 2. Prunes old temporal data (Activity Feed, Audit Logs, Worker Failures)
 */
export async function runCleanupScheduler() {
  console.log('[Cleanup-Scheduler] Running stuck job cleanup and data pruning...');

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    // 1. Clean up stuck ImportJobs
    const stuckImportJobs = await prisma.importJob.updateMany({
      where: {
        status: { in: ['pending', 'processing'] },
        created_at: { lt: oneHourAgo }
      },
      data: {
        status: 'failed',
        error_log: {
          error: 'Job timed out',
          message: 'This job was stuck for over an hour and was automatically failed by the cleanup scheduler.'
        },
        completed_at: now
      }
    });

    if (stuckImportJobs.count > 0) {
      console.log(`[Cleanup-Scheduler] Automatically failed ${stuckImportJobs.count} stuck import jobs.`);
    }

    // 2. Prune Activity Feed (Temporal Data)
    // user_availability_feed (90 days retention)
    const prunedAvailability = await prisma.$executeRaw`
      DELETE FROM user_availability_feed 
      WHERE discovered_at < ${ninetyDaysAgo}
    `;
    
    // feed_entries (90 days retention)
    const prunedFeedEntries = await prisma.feedEntry.deleteMany({
      where: {
        created_at: { lt: ninetyDaysAgo }
      }
    });

    // 3. Prune System Logs
    // audit_logs (90 days retention)
    const prunedAuditLogs = await prisma.auditLog.deleteMany({
      where: {
        created_at: { lt: ninetyDaysAgo }
      }
    });

    // worker_failures (30 days retention - shorter to save space)
    const prunedFailures = await prisma.workerFailure.deleteMany({
      where: {
        created_at: { lt: thirtyDaysAgo }
      }
    });

    console.log('[Cleanup-Scheduler] Pruning complete:', {
      user_availability_feed: prunedAvailability,
      feed_entries: prunedFeedEntries.count,
      audit_logs: prunedAuditLogs.count,
      worker_failures: prunedFailures.count
    });

  } catch (error) {
    console.error('[Cleanup-Scheduler] Failed to run cleanup/pruning:', error);
  }
}
