import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/prisma';
import { seriesResolutionQueue } from '@/lib/queues';
import { validateUUID, checkRateLimit, handleApiError, ApiError, validateOrigin, ErrorCodes, getClientIp } from '@/lib/api-utils';

/**
 * POST /api/library/[id]/retry-metadata
 * Retries the metadata enrichment process for a library entry
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // CSRF Protection
    validateOrigin(req);

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    const { id: entryId } = await params;
    
    // Validate UUID format
    validateUUID(entryId, 'entryId');

    // Rate limit: 10 retries per minute per user
    if (!await checkRateLimit(`metadata-retry:${user.id}`, 10, 60000)) {
      throw new ApiError('Too many retry attempts. Please wait.', 429, ErrorCodes.RATE_LIMITED);
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Get current entry
      const entry = await tx.libraryEntry.findUnique({
        where: { id: entryId, user_id: user.id },
      });

      if (!entry) {
        throw new ApiError('Library entry not found', 404, ErrorCodes.NOT_FOUND);
      }

      // 2. Reset status and review flag
      const updatedEntry = await tx.libraryEntry.update({
        where: { id: entryId },
        data: {
          metadata_status: 'pending',
          needs_review: false,
        },
      });

        // 3. Create activity record for the feed
        await tx.activity.create({
          data: {
            user_id: user.id,
            type: 'retry',
            series_id: entry.series_id || undefined,
            metadata: {
              entry_id: entryId,
              action: 'manual_retry'
            }
          }
        });

        // 4. Requeue resolution job
        await seriesResolutionQueue.add(`retry-resolution-${entryId}`, {
        libraryEntryId: entryId,
        source_url: entry.source_url,
        title: entry.imported_title || undefined,
      }, {
        priority: 1, // High priority for manual retries
        attempts: 5,
        backoff: { type: 'exponential', delay: 30000 },
      });

      return updatedEntry;
    });

    return NextResponse.json({
      success: true,
      message: 'Metadata enrichment retried',
      entry: result,
    });
  } catch (error: any) {
    return handleApiError(error);
  }
}
