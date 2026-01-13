import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes } from "@/lib/api-utils"
import { createClient } from "@/lib/supabase/server"
import { seriesResolutionQueue } from "@/lib/queues"

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`retry-all-metadata:${ip}`, 5, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    // Find all failed entries for this user
    const failedEntries = await prisma.libraryEntry.findMany({
      where: {
        user_id: user.id,
        metadata_status: "failed"
      },
      select: { id: true, source_url: true, imported_title: true }
    });

    if (failedEntries.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: "No failed entries found.",
        count: 0
      });
    }

    // Reset status to pending
    await prisma.libraryEntry.updateMany({
      where: {
        id: { in: failedEntries.map(e => e.id) }
      },
      data: {
        metadata_status: "pending",
        metadata_retry_count: 0,
        last_metadata_error: null
      }
    });

    // Enqueue for resolution
    const jobs = failedEntries.map(entry => ({
      name: `enrich-${entry.id}`,
      data: { 
        libraryEntryId: entry.id, 
        source_url: entry.source_url, 
        title: entry.imported_title 
      },
      opts: { 
        jobId: `enrich-${entry.id}`, 
        priority: 2, 
        removeOnComplete: true,
        // Ensure we actually retry by removing any existing completed/failed jobs
        removeOnFail: true 
      }
    }));

    await seriesResolutionQueue.addBulk(jobs);

    return NextResponse.json({ 
      success: true, 
      message: `Successfully queued ${failedEntries.length} entries for metadata retry.`,
      count: failedEntries.length
    });
  } catch (error) {
    return handleApiError(error);
  }
}
