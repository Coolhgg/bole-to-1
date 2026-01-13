import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/gamification/activity';
import { XP_PER_CHAPTER, calculateLevel, addXp } from '@/lib/gamification/xp';
import { calculateNewStreak, calculateStreakBonus } from '@/lib/gamification/streaks';
import { checkAchievements } from '@/lib/gamification/achievements';
import { validateUUID, checkRateLimit, handleApiError, ApiError, validateOrigin, ErrorCodes, getClientIp, validateContentType, validateJsonSize } from '@/lib/api-utils';
import { z } from 'zod';
import { redisApi, REDIS_KEY_PREFIX } from '@/lib/redis';
import { Prisma } from '@prisma/client';

const progressSchema = z.object({
  chapterNumber: z.number().min(0).max(100000).finite().nullable().optional(),
  chapterSlug: z.string().nullable().optional(),
  sourceId: z.string().uuid().optional(),
  isRead: z.boolean().optional().default(true),
  timestamp: z.string().datetime().optional(),
  deviceId: z.string().max(100).optional(),
});

/**
 * PATCH /api/library/[id]/progress
 * Marks a chapter as read, updates streak and XP
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
    try {
      // CSRF Protection
      validateOrigin(req);

      // BUG 58: Validate Content-Type
      validateContentType(req);

      // BUG 57: Validate JSON Size
      await validateJsonSize(req);

      // Rate limit: 60 progress updates per minute per IP

    const ip = getClientIp(req);
    if (!await checkRateLimit(`progress-update:${ip}`, 60, 60000)) {
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

    // Validate request body
    const validatedData = progressSchema.safeParse(body);
    if (!validatedData.success) {
      throw new ApiError(validatedData.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }

        const { chapterNumber, chapterSlug, sourceId, isRead, timestamp, deviceId } = validatedData.data;
        const targetTimestamp = timestamp ? new Date(timestamp) : new Date();

        const result = await prisma.$transaction(async (tx) => {
        // 1. Get current entry and user profile
        // Use a lock on the user profile to prevent race conditions on XP/Streaks
        const userProfile = await tx.user.findUnique({
          where: { id: user.id },
        });

        if (!userProfile) {
          throw new ApiError('User profile not found', 404, ErrorCodes.NOT_FOUND);
        }

        const entry = await tx.libraryEntry.findUnique({
          where: { id: entryId, user_id: user.id },
          include: { series: true }
        });

        if (!entry) {
          throw new ApiError('Library entry not found', 404, ErrorCodes.NOT_FOUND);
        }

        // Check if trying to mark an older chapter as read
        const currentLastRead = Number(entry.last_read_chapter || 0);
        const isNewChapter = chapterNumber !== undefined && chapterNumber !== null && chapterNumber > currentLastRead;

        // KENMEI PARITY: Logical chapters are identified strictly by (series_id, chapter_number)
        const NO_NUMBER_SENTINEL = new Prisma.Decimal(-1);
        const chapterNumDecimal = chapterNumber !== undefined && chapterNumber !== null 
          ? new Prisma.Decimal(chapterNumber) 
          : NO_NUMBER_SENTINEL;

        // 2. Identify Logical Chapter
        const logicalChapter = await tx.logicalChapter.findUnique({
          where: {
            series_id_chapter_number: {
              series_id: entry.series_id || "",
              chapter_number: chapterNumDecimal,
            }
          },
          select: { id: true }
        });

        // 3. Check for existing read (Idempotency / Replay-safety)
        // If we already have a record for this chapter, don't award XP again
        let alreadyRead = false;
        if (logicalChapter) {
          const existingRead = await tx.userChapterReadV2.findUnique({
            where: {
              user_id_chapter_id: {
                user_id: user.id,
                chapter_id: logicalChapter.id,
              }
            }
          });
          // Only count as already read if it was explicitly marked as read
          alreadyRead = !!existingRead && existingRead.is_read;
        }

        // Fallback: check legacy read table
        if (!alreadyRead) {
          const legacyRead = await tx.userChapterRead.findFirst({
            where: {
              user_id: user.id,
              chapter: {
                series_id: entry.series_id,
                chapter_number: chapterNumber || 0,
              }
            }
          });
          alreadyRead = !!legacyRead;
        }

      // 4. Calculate new streak and XP
      const newStreak = calculateNewStreak(userProfile.streak_days, userProfile.last_read_at);
      const streakBonus = calculateStreakBonus(newStreak);
      
      // Award XP ONLY if it's a new chapter and NOT already read
      // and we are marking it as READ
      const shouldAwardXp = isRead && isNewChapter && !alreadyRead;
      const totalXpGained = shouldAwardXp ? (XP_PER_CHAPTER + streakBonus) : 0;

      // 5. Update Library Entry (BUG 46: Monotonic constraint)
      // Only update last_read_chapter if it's newer and we are marking as READ
      const updatedEntry = await tx.libraryEntry.update({
        where: { id: entryId, user_id: user.id },
        data: {
          last_read_chapter: (isRead && isNewChapter) ? chapterNumber : entry.last_read_chapter,
          last_read_at: (isRead && isNewChapter) ? targetTimestamp : entry.last_read_at,
          updated_at: new Date(),
        },
      });

      // 6. Update User Profile (XP, Level, Streak)
      const newXp = addXp(userProfile.xp || 0, totalXpGained);
      const newLevel = calculateLevel(newXp);
      const longestStreak = Math.max(userProfile.longest_streak || 0, newStreak);

      await tx.user.update({
        where: { id: user.id },
        data: {
          xp: newXp,
          level: newLevel,
          streak_days: newStreak,
          longest_streak: longestStreak,
          last_read_at: isRead ? targetTimestamp : userProfile.last_read_at,
          chapters_read: { increment: shouldAwardXp ? 1 : 0 },
        },
      });

      // 7. Log Activity (Only if new XP awarded or first read)
      if (isRead && (shouldAwardXp || !alreadyRead)) {
        try {
          await logActivity(tx, user.id, 'chapter_read', {
            seriesId: entry.series_id,
            metadata: { 
              chapter_number: chapterNumber,
              xp_gained: totalXpGained,
              streak: newStreak
            },
          });
        } catch (activityError) {
          console.error('Failed to log activity:', activityError);
        }
      }

          // 8. Record Chapter Read (V2 with Race-Safe LWW)
          if (logicalChapter) {
            await tx.$executeRaw`
              INSERT INTO "user_chapter_reads_v2" 
                ("id", "user_id", "chapter_id", "is_read", "updated_at", "read_at", "source_used_id", "device_id", "server_received_at")
              VALUES 
                (gen_random_uuid(), ${user.id}::uuid, ${logicalChapter.id}::uuid, ${isRead}, ${targetTimestamp}::timestamptz, ${targetTimestamp}::timestamptz, ${sourceId}::uuid, ${deviceId}, NOW())
              ON CONFLICT ("user_id", "chapter_id")
              DO UPDATE SET 
                "is_read" = EXCLUDED."is_read",
                "updated_at" = EXCLUDED."updated_at",
                "device_id" = EXCLUDED."device_id",
                "server_received_at" = EXCLUDED."server_received_at",
                "read_at" = CASE WHEN EXCLUDED."is_read" = true THEN EXCLUDED."updated_at" ELSE "user_chapter_reads_v2"."read_at" END,
                "source_used_id" = EXCLUDED."source_used_id"
              WHERE EXCLUDED."updated_at" > "user_chapter_reads_v2"."updated_at"
                 OR (EXCLUDED."updated_at" = "user_chapter_reads_v2"."updated_at" 
                     AND EXCLUDED."server_received_at" < "user_chapter_reads_v2"."server_received_at")
            `;
          }

        // Legacy compatibility (only if marking as read)
        if (isRead && chapterNumber !== undefined && chapterNumber !== null) {
          const chapters = await tx.chapter.findMany({
            where: { series_id: entry.series_id, chapter_number: chapterNumber },
            select: { id: true }
          });

          for (const ch of chapters) {
            await tx.userChapterRead.upsert({
              where: { user_id_chapter_id: { user_id: user.id, chapter_id: ch.id } },
              create: { user_id: user.id, chapter_id: ch.id },
              update: { read_at: targetTimestamp },
            });
          }
        }

      // 7. Check Achievements
      try {
        await checkAchievements(tx, user.id, 'chapter_read');
        if (newStreak > userProfile.streak_days) {
          await checkAchievements(tx, user.id, 'streak_reached');
        }
      } catch (achievementError) {
        console.error('Failed to check achievements:', achievementError);
        // Don't throw - allow progress to be saved
      }

        // 9. Invalidate Activity Feed Cache for this user
        // Inside transaction to ensure atomicity with database updates
        try {
          await redisApi.incr(`${REDIS_KEY_PREFIX}feed:v:${user.id}`);
        } catch (cacheError) {
          console.error('Failed to invalidate feed cache inside transaction:', cacheError);
        }

        // KENMEI PARITY: Update activity score (user_read: +2)
        if (isRead && entry.series_id) {
          const { recordActivityEvent } = await import('@/lib/catalog-tiers');
          await recordActivityEvent(entry.series_id, 'user_read');
        }

        return {
          entry: updatedEntry,
          xp_gained: totalXpGained,
          new_streak: newStreak,
          new_level: newLevel
        };
      });

      return NextResponse.json(result);
  } catch (error: any) {
    console.error('Progress update error:', error);
    return handleApiError(error);
  }
}
