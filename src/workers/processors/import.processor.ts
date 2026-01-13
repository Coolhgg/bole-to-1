import { Job } from 'bullmq';
import { processImportJob } from '@/lib/sync/import-pipeline';

/**
 * Processor for the import queue.
 * Handles background processing of series import jobs (CSV, MAL, etc).
 */
export async function processImport(job: Job) {
  const { jobId } = job.data;
  
  if (!jobId) {
    throw new Error('Missing jobId in import job data');
  }

  console.log(`[ImportWorker] Starting import job: ${jobId}`);
  
  try {
    await processImportJob(jobId);
    console.log(`[ImportWorker] Successfully completed import job: ${jobId}`);
  } catch (error) {
    console.error(`[ImportWorker] Failed to process import job ${jobId}:`, error);
    throw error;
  }
}
