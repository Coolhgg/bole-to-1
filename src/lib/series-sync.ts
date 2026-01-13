import { prisma, withRetry } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ScrapedChapter } from "@/lib/scrapers";
import { updateSeriesBestCover } from "@/lib/cover-resolver";
import { normalizeChapter } from "./chapter-normalization";
import { recordActivityEvent, ActivityEventType } from "./catalog-tiers";

export interface SyncOptions {
  forceUpdate?: boolean;
  skipLegacy?: boolean;
}

export async function syncChapters(
  seriesId: string,
  sourceId: string,
  sourceName: string,
  scrapedChapters: ScrapedChapter[],
  options: SyncOptions = {}
) {
  if (scrapedChapters.length === 0) return 0;

  // 1. Get the source record
  const seriesSource = await prisma.seriesSource.findUnique({
    where: { source_name_source_id: { source_name: sourceName, source_id: sourceId } },
  });

  if (!seriesSource) {
    throw new Error(`Series source ${sourceName}:${sourceId} not found`);
  }

  // 2. Perform upserts in batches to avoid transaction timeouts
  let newChaptersCount = 0;
  let maxChapterNumber = new Prisma.Decimal(0);
  const BATCH_SIZE = 50;
  const NO_NUMBER_SENTINEL = new Prisma.Decimal(-1);

    for (let i = 0; i < scrapedChapters.length; i += BATCH_SIZE) {
      const batch = scrapedChapters.slice(i, i + BATCH_SIZE);
      const eventsToRecord: { type: ActivityEventType; source?: string }[] = [];
      
      await prisma.$transaction(async (tx) => {
        for (const ch of batch) {
          // Apply Normalization Logic
          const normalized = normalizeChapter(ch.chapterLabel || `Chapter ${ch.chapterNumber}`, ch.chapterTitle);
          // KENMEI PARITY: Identification is strictly (series_id, chapter_number)
          const chNumDecimal = normalized.number !== null ? new Prisma.Decimal(normalized.number) : NO_NUMBER_SENTINEL;
          const chNum = chNumDecimal.toString();
          const chSlug = normalized.slug;
  
          if (chNumDecimal.greaterThan(maxChapterNumber)) {
            maxChapterNumber = chNumDecimal;
          }
  
          // 1. Identify/Create Logical Chapter (Kenmei Rule 1)
          const existingChapter = await tx.chapter.findUnique({
            where: {
              series_id_chapter_number: {
                series_id: seriesId,
                chapter_number: chNum,
              },
            },
          });

          const chapter = await tx.chapter.upsert({
            where: {
              series_id_chapter_number: {
                series_id: seriesId,
                chapter_number: chNum,
              },
            },
            update: {
              chapter_title: ch.chapterTitle || undefined,
              published_at: ch.publishedAt || undefined,
              chapter_slug: chSlug || undefined,
            },
            create: {
              series_id: seriesId,
              chapter_number: chNum,
              chapter_slug: chSlug || "",
              chapter_title: ch.chapterTitle,
              published_at: ch.publishedAt || null,
            },
          });

          // Track: First Appearance
          if (!existingChapter) {
            eventsToRecord.push({ type: 'chapter_first_appearance' });
          }
  
          // 2. Update/Create ChapterSource (Kenmei Rule 2 & 4)
          const existingSource = await tx.chapterSource.findUnique({
            where: {
              series_source_id_chapter_id: {
                series_source_id: seriesSource.id,
                chapter_id: chapter.id,
              },
            },
          });

          await tx.chapterSource.upsert({
            where: {
              series_source_id_chapter_id: {
                series_source_id: seriesSource.id,
                chapter_id: chapter.id,
              },
            },
            update: {
              source_chapter_url: ch.chapterUrl,
              chapter_title: ch.chapterTitle,
              source_published_at: ch.publishedAt || undefined,
              is_available: true,
            },
            create: {
              chapter_id: chapter.id,
              series_source_id: seriesSource.id,
              source_name: sourceName,
              source_chapter_url: ch.chapterUrl,
              chapter_title: ch.chapterTitle,
              source_published_at: ch.publishedAt || null,
              detected_at: new Date(),
            },
          });

          // Track: Chapter Detected (per source)
          if (!existingSource) {
            eventsToRecord.push({ type: 'chapter_detected', source: sourceName });
          }
  
          // 3. Keep legacy Chapter model in sync
          if (!options.skipLegacy) {
            await tx.legacyChapter.upsert({
              where: {
                series_source_id_chapter_number: {
                  series_source_id: seriesSource.id,
                  chapter_number: chNumDecimal,
                },
              },
              update: {
                chapter_title: ch.chapterTitle,
                chapter_url: ch.chapterUrl,
                published_at: ch.publishedAt || undefined,
                is_available: true,
              },
              create: {
                series_id: seriesId,
                series_source_id: seriesSource.id,
                chapter_number: chNumDecimal,
                chapter_title: ch.chapterTitle,
                chapter_url: ch.chapterUrl,
                published_at: ch.publishedAt || null,
                discovered_at: new Date(),
              },
            });
          }
  
          newChaptersCount++;
        }
      }, { 
        timeout: 30000, 
        maxWait: 5000   
      });

      // Record events OUTSIDE transaction to avoid timeouts
      for (const event of eventsToRecord) {
        await recordActivityEvent(seriesId, event.type, event.source).catch(err => 
          console.error(`[Sync] Failed to record activity event ${event.type} for ${seriesId}:`, err)
        );
      }
    }

  // 3. Update source and series metadata (Final state)
  await prisma.$transaction(async (tx) => {
    // Update source heartbeat
    await tx.seriesSource.update({
      where: { id: seriesSource.id },
      data: {
        last_success_at: new Date(),
        last_checked_at: new Date(),
        failure_count: 0,
      },
    });

    // Update series metadata
    const series = await tx.series.findUnique({ where: { id: seriesId } });
    if (series) {
      const currentMax = series.latest_chapter ? new Prisma.Decimal(series.latest_chapter) : new Prisma.Decimal(0);
      if (maxChapterNumber.greaterThan(currentMax)) {
        await tx.series.update({
          where: { id: seriesId },
          data: {
            latest_chapter: maxChapterNumber,
            last_chapter_at: new Date(),
            updated_at: new Date(),
          },
        });
      }
    }
  });

  // 3. Post-sync optimizations (Outside transaction)
  try {
    // Ensure best cover is up to date
    await updateSeriesBestCover(seriesId);
  } catch (err) {
    console.error(`[Sync] Failed to update best cover for ${seriesId}:`, err);
  }

  return newChaptersCount;
}
