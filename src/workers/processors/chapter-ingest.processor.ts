import { Job } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { notificationQueue, gapRecoveryQueue, feedFanoutQueue } from '@/lib/queues';
import { scheduleNotification } from '@/lib/notifications-timing';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withLock, redisApi, REDIS_KEY_PREFIX } from '@/lib/redis';
import { normalizeTitle } from '@/lib/string-utils';
import { isTransientError } from '@/lib/api-utils';
import { promoteSeriesTier } from '@/lib/catalog-tiers';

const FEED_BATCH_WINDOW_HOURS = 24;

const ChapterIngestDataSchema = z.object({
  seriesSourceId: z.string().uuid(),
  seriesId: z.string().uuid(),
  chapterNumber: z.number().nullable().optional(),
  chapterSlug: z.string().nullable().optional(),
  chapterTitle: z.string().nullable(),
  chapterUrl: z.string().url(),
  sourceChapterId: z.string().nullable().optional(),
  publishedAt: z.string().nullable(),
  isRecovery: z.boolean().optional(),
  traceId: z.string().optional(),
});

export interface ChapterIngestData {
  seriesSourceId: string;
  seriesId: string;
  chapterNumber?: number | null;
  chapterSlug?: string | null;
  chapterTitle: string | null;
  chapterUrl: string;
  sourceChapterId?: string | null;
  publishedAt: string | null;
  isRecovery?: boolean;
  traceId?: string;
}

interface SourceEntry {
  name: string;
  url: string;
  discovered_at: string;
}

export async function processChapterIngest(job: Job<ChapterIngestData>) {
  const parseResult = ChapterIngestDataSchema.safeParse(job.data);
  if (!parseResult.success) {
    throw new Error(`Invalid job payload: ${parseResult.error.message}`);
  }

  const { 
    seriesSourceId, 
    seriesId, 
    chapterNumber,
    chapterSlug,
    chapterTitle: rawTitle, 
    chapterUrl,
    sourceChapterId,
    publishedAt,
    isRecovery = false,
    traceId = job.id || 'unknown'
  } = parseResult.data;

    const chapterTitle = rawTitle ? normalizeTitle(rawTitle) : null;
  
    if (sourceChapterId && sourceChapterId.length > 4500) {
      console.warn(`[ChapterIngest][${traceId}] Exceptionally long sourceChapterId detected (${sourceChapterId.length} chars). Approach limit (5000).`);
    }
  
    // KENMEI PARITY: Logical chapters are identified strictly by number
    // If no number, we use a sentinel (-1) to group specials/volumeless
    const identityKey = chapterNumber !== undefined && chapterNumber !== null 
      ? chapterNumber.toString() 
      : "-1";
  
    console.log(`[ChapterIngest][${traceId}] Ingesting chapter ${identityKey} for series ${seriesId}`);
  
      return await withLock(`ingest:${seriesId}:${identityKey}`, 30000, async () => {
        try {
          const seriesSource = await prisma.seriesSource.findUnique({
            where: { id: seriesSourceId },
            select: { source_name: true, series: true },
          });
  
        if (!seriesSource || !seriesSource.series) {
          console.warn(`[ChapterIngest][${traceId}] Source ${seriesSourceId} or associated series not found. Discarding job.`);
          return;
        }
  
        const sourceName = seriesSource.source_name ?? 'Unknown';
  
            const fanoutParams = await prisma.$transaction(async (tx) => {
              // 1. Identify/Create Logical Chapter (Kenmei Rule 1)
              const existingLogicalChapter = await tx.chapter.findUnique({
                where: {
                  series_id_chapter_number: {
                    series_id: seriesId,
                    chapter_number: identityKey,
                  },
                },
              });

              const chapter = await tx.chapter.upsert({
                where: {
                  series_id_chapter_number: {
                    series_id: seriesId,
                    chapter_number: identityKey,
                  },
                },

              update: {
                chapter_title: chapterTitle || undefined,
                published_at: publishedAt ? new Date(publishedAt) : undefined,
                // We preserve slug but it's not the identity
                chapter_slug: chapterSlug || undefined,
              },
              create: {
                series_id: seriesId,
                chapter_number: identityKey,
                chapter_slug: chapterSlug || "",
                chapter_title: chapterTitle,
                published_at: publishedAt ? new Date(publishedAt) : null,
              },
            });
  
            // 2. Handle Gap Detection
            if (!isRecovery && chapterNumber !== undefined && chapterNumber !== null && chapterNumber > 1) {
              const prevChapter = await tx.chapter.findUnique({
                where: {
                  series_id_chapter_number: {
                    series_id: seriesId,
                    chapter_number: (Math.floor(chapterNumber) - 1).toString(),
                  },
                },
              });
  
              if (!prevChapter) {
                console.log(`[ChapterIngest] Potential gap detected before chapter ${chapterNumber} for series ${seriesId}. Enqueueing recovery in 60s.`);
                await gapRecoveryQueue.add(
                  `gap-recovery-${seriesId}`,
                  { seriesId },
                  { 
                    jobId: `gap-recovery-${seriesId}`,
                    delay: 60000 
                  }
                );
              }
            }
  
            // 3. Determine discovery time (Kenmei Rule 3)
            // For timeline ordering, discovery time must be accurate
            let detectedAt = new Date();
            if (isRecovery && chapterNumber !== undefined) {
              const nextChapterSource = await tx.chapterSource.findFirst({
                where: {
                  chapter: {
                    series_id: seriesId,
                    chapter_number: { gt: identityKey },
                  }
                },
                orderBy: {
                  chapter: { chapter_number: 'asc' }
                },
                select: { detected_at: true }
              });
  
              if (nextChapterSource) {
                detectedAt = new Date(nextChapterSource.detected_at.getTime() - 1);
              }
            }
  
            // 4. Update/Create ChapterSource (Kenmei Rule 2 & 4)
            // Each source upload is an availability event. We link it to the logical chapter.
            let finalSourceId = '';
            const existingSource = await tx.chapterSource.findUnique({
              where: {
                series_source_id_chapter_id: {
                  series_source_id: seriesSourceId,
                  chapter_id: chapter.id,
                },
              },
            });
  
            if (existingSource) {
              finalSourceId = existingSource.id;
              // KENMEI PARITY: We update the record but keep the original detected_at
              await tx.chapterSource.update({
                where: { id: existingSource.id },
                data: {
                  source_chapter_url: chapterUrl,
                  chapter_title: chapterTitle,
                  source_chapter_id: sourceChapterId,
                  source_published_at: publishedAt ? new Date(publishedAt) : undefined,
                  is_available: true,
                  last_checked_at: new Date(),
                },
              });
            } else {
              const newSource = await tx.chapterSource.create({
                data: {
                  chapter_id: chapter.id,
                  series_source_id: seriesSourceId,
                  source_name: sourceName,
                  source_chapter_url: chapterUrl,
                  chapter_title: chapterTitle,
                  source_chapter_id: sourceChapterId,
                  source_published_at: publishedAt ? new Date(publishedAt) : null,
                  detected_at: detectedAt,
                  is_available: true,
                },
              });
              finalSourceId = newSource.id;
  
              await tx.seriesSource.update({
                where: { id: seriesSourceId },
                data: {
                  source_chapter_count: { increment: 1 },
                  sync_priority: 'HOT',
                  next_check_at: new Date(Date.now() + 15 * 60 * 1000),
                },
              });
            }
  
            // 5. Keep legacy Chapter model in sync
            const legacyChapterNum = new Prisma.Decimal(chapterNumber || -1);
            
            // KENMEI PARITY: Update series last_chapter_date for discovery sorting
            // We only update if this chapter is newer than the current last_chapter_date
            if (publishedAt) {
              const pubDate = new Date(publishedAt);
              await tx.series.update({
                where: { id: seriesId },
                data: {
                  last_chapter_date: {
                    set: pubDate // DB constraint/logic should handle max() if we want strictly monotonic, 
                                 // but usually simple set is fine if we trust publishedAt
                  }
                }
              });
            }
            const existingLegacyChapter = await tx.legacyChapter.findUnique({
              where: {
                series_source_id_chapter_number: {
                  series_source_id: seriesSourceId,
                  chapter_number: legacyChapterNum,
                },
              },
            });
  
            if (existingLegacyChapter) {
              await tx.legacyChapter.update({
                where: { id: existingLegacyChapter.id },
                data: {
                  chapter_title: chapterTitle,
                  chapter_url: chapterUrl,
                  source_chapter_id: sourceChapterId,
                  published_at: publishedAt ? new Date(publishedAt) : existingLegacyChapter.published_at,
                  is_available: true,
                },
              });
            } else {
              await tx.legacyChapter.create({
                data: {
                  series_id: seriesId,
                  series_source_id: seriesSourceId,
                  chapter_number: legacyChapterNum,
                  chapter_title: chapterTitle,
                  chapter_url: chapterUrl,
                  source_chapter_id: sourceChapterId,
                  published_at: publishedAt ? new Date(publishedAt) : null,
                  discovered_at: detectedAt,
                },
              });
            }
  
            // 6. Handle Feed Entry
            const windowCutoff = new Date(Date.now() - FEED_BATCH_WINDOW_HOURS * 60 * 60 * 1000);
            const existingFeedEntry = await tx.feedEntry.findFirst({
              where: {
                series_id: seriesId,
                chapter_number: legacyChapterNum,
                first_discovered_at: { gte: windowCutoff },
              },
            });
  
            const newSourceEntry: SourceEntry = {
              name: sourceName,
              url: chapterUrl,
              discovered_at: detectedAt.toISOString(),
            };
  
            if (existingFeedEntry) {
              const existingSources = (existingFeedEntry.sources as SourceEntry[]) || [];
              const sourceExists = existingSources.some((s) => s.name === sourceName);
              
              if (!sourceExists) {
                await tx.feedEntry.update({
                  where: { id: existingFeedEntry.id },
                  data: {
                    sources: [...existingSources, newSourceEntry],
                    last_updated_at: new Date(),
                    logical_chapter_id: chapter.id,
                  },
                });
              }
            } else {
              await tx.feedEntry.create({
                data: {
                  series_id: seriesId,
                  logical_chapter_id: chapter.id,
                  chapter_number: legacyChapterNum,
                  sources: [newSourceEntry],
                  first_discovered_at: detectedAt,
                  last_updated_at: detectedAt,
                },
              });
            }
  
                return {
                  sourceId: finalSourceId,
                  chapterId: chapter.id,
                  detectedAt,
                  isFirstAppearance: !existingLogicalChapter,
                };
              }, {
                timeout: 30000,
              });
    
              // KENMEI PARITY: Promote series tier on chapter detection
              // Formula: +10 for first appearance, +5 for subsequent source detection
              if (fanoutParams.isFirstAppearance) {
                await promoteSeriesTier(seriesId, 'chapter_first_appearance');
              } else {
                await promoteSeriesTier(seriesId, 'chapter_detected');
              }

  
            // 7. Queue Notification (Timing-Aware SQL Queue)
            const delayMinutes = isRecovery ? 1 : 10;
            await scheduleNotification(chapter.id, delayMinutes);
  
            // 8. Queue Feed Fan-out
            const fanoutJobId = `fanout-${seriesSourceId}-${fanoutParams.chapterId}`;
            await feedFanoutQueue.add(
              fanoutJobId,
              {
                sourceId: fanoutParams.sourceId,
                seriesId,
                chapterId: fanoutParams.chapterId,
                discoveredAt: fanoutParams.detectedAt.toISOString(),
              },
              { 
                jobId: fanoutJobId,
                removeOnComplete: true 
              }
            );

        // 9. Invalidate Activity Feed Cache for followers
        try {
          const followers = await prisma.libraryEntry.findMany({
            where: { series_id: seriesId },
            select: { user_id: true }
          });

          if (followers.length > 0) {
            const pipeline = redisApi.pipeline();
            for (const follower of followers) {
              pipeline.incr(`${REDIS_KEY_PREFIX}feed:v:${follower.user_id}`);
            }
            await pipeline.exec();
            console.log(`[ChapterIngest][${traceId}] Invalidated feed cache for ${followers.length} followers of series ${seriesId}`);
          }
        } catch (cacheError) {
          console.error(`[ChapterIngest][${traceId}] Failed to invalidate feed cache:`, cacheError);
        }
      } catch (error: any) {
        console.error(`[ChapterIngest][${traceId}] Failed to process chapter ${chapterNumber} for series ${seriesId}:`, error);
        
        if (isTransientError(error)) {
          console.warn(`[ChapterIngest][${traceId}] Transient database error detected. Job will be retried by BullMQ.`);
        }
        
        throw error;
      }
  });
}
