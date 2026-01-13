import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { logActivity } from '@/lib/gamification/activity';
import { XP_SERIES_COMPLETED, calculateLevel } from '@/lib/gamification/xp';
import { checkAchievements } from '@/lib/gamification/achievements';
import { validateUUID, checkRateLimit, handleApiError, ApiError, validateOrigin, ErrorCodes, getClientIp, validateContentType, validateJsonSize } from '@/lib/api-utils';
import { recordSignal } from '@/lib/analytics/signals';

/**
 * PATCH /api/library/[id]
 * Updates a library entry status or rating
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // CSRF Protection
    validateOrigin(req);

    // BUG FIX: Validate Content-Type
    validateContentType(req);

    // BUG FIX: Validate JSON Size
    await validateJsonSize(req);

    // Rate limit: 30 updates per minute per IP
    const ip = getClientIp(req);
    if (!await checkRateLimit(`library-update:${ip}`, 30, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    const { id: entryId } = await params;
    
    // Validate UUID format
    validateUUID(entryId, 'entryId');

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }
    
    const { status, rating, preferred_source } = body;

    // Validate status if provided
    if (status) {
      const validStatuses = ['reading', 'completed', 'planning', 'dropped', 'paused'];
      if (!validStatuses.includes(status)) {
        throw new ApiError('Invalid status', 400, ErrorCodes.VALIDATION_ERROR);
      }
    }

    // Validate rating if provided
    if (rating !== undefined && rating !== null) {
      const ratingNum = Number(rating);
      if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 10) {
        throw new ApiError('Rating must be between 1 and 10', 400, ErrorCodes.VALIDATION_ERROR);
      }
    }

    // Validate preferred_source if provided
    if (preferred_source !== undefined && preferred_source !== null) {
      if (typeof preferred_source !== 'string' || preferred_source.length > 50) {
        throw new ApiError('Invalid preferred source', 400, ErrorCodes.VALIDATION_ERROR);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Get current entry
      const currentEntry = await tx.libraryEntry.findUnique({
        where: { id: entryId, user_id: user.id },
      });

      if (!currentEntry) {
        throw new ApiError('Library entry not found', 404, ErrorCodes.NOT_FOUND);
      }

      // 2. Prepare update data
      const updateData: Prisma.LibraryEntryUpdateInput = {};
      if (status) updateData.status = status;
      if (rating !== undefined) updateData.user_rating = rating;
      if (preferred_source !== undefined) updateData.preferred_source = preferred_source;

      // 3. Update entry
      const updatedEntry = await tx.libraryEntry.update({
        where: { id: entryId, user_id: user.id },
        data: updateData,
      });

      // 4. Handle side effects if status changed to 'completed'
      if (status === 'completed' && currentEntry.status !== 'completed') {
        // Award XP
        const userProfile = await tx.user.findUnique({
          where: { id: user.id },
          select: { xp: true },
        });

        const newXp = (userProfile?.xp || 0) + XP_SERIES_COMPLETED;
        const newLevel = calculateLevel(newXp);

        await tx.user.update({
          where: { id: user.id },
          data: {
            xp: newXp,
            level: newLevel,
          },
        });

        // Log activity
        await logActivity(tx, user.id, 'series_completed', {
          seriesId: currentEntry.series_id,
        });

        // Check achievements
        await checkAchievements(tx, user.id, 'series_completed');
      } else if (status && status !== currentEntry.status) {
        // Log status update activity
        await logActivity(tx, user.id, 'status_updated', {
          seriesId: currentEntry.series_id,
          metadata: { old_status: currentEntry.status, new_status: status },
        });
      }

      return { entry: updatedEntry, seriesId: currentEntry.series_id };
    });

    // Record rating signal outside transaction (non-blocking)
    if (rating !== undefined && rating !== null && result.seriesId) {
      recordSignal({
        user_id: user.id,
        series_id: result.seriesId,
        signal_type: 'rating',
        metadata: { rating: Number(rating) }
      }).catch(err => console.error('[Library] Failed to record rating signal:', err.message));
    }

    return NextResponse.json(result.entry);
  } catch (error: any) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/library/[id]
 * Removes a series from the user's library
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // CSRF Protection
    validateOrigin(req);

    // Rate limit: 30 deletes per minute per IP
    const ip = getClientIp(req);
    if (!await checkRateLimit(`library-delete:${ip}`, 30, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    const { id: entryId } = await params;
    
    // Validate UUID format
    validateUUID(entryId, 'entryId');

    const deletedEntry = await prisma.$transaction(async (tx) => {
      const entry = await tx.libraryEntry.findUnique({
        where: { id: entryId, user_id: user.id },
        select: { series_id: true },
      });

      if (!entry) {
        throw new ApiError('Library entry not found', 404, ErrorCodes.NOT_FOUND);
      }

      // 1. Delete entry
      await tx.libraryEntry.delete({
        where: { id: entryId, user_id: user.id },
      });

      // 2. Atomically decrement series follow count (using SQL for floor check)
      if (entry.series_id) {
        await tx.$executeRaw`
          UPDATE series 
          SET total_follows = GREATEST(0, total_follows - 1)
          WHERE id = ${entry.series_id}::uuid
        `;
      }

      return entry;
    });

    // Record remove_from_library signal (non-blocking)
    if (deletedEntry.series_id) {
      recordSignal({
        user_id: user.id,
        series_id: deletedEntry.series_id,
        signal_type: 'remove_from_library',
        metadata: { source: 'library_page' }
      }).catch(err => console.error('[Library] Failed to record remove signal:', err.message));
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return handleApiError(error);
  }
}
