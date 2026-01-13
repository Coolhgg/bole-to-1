import { prisma } from "@/lib/prisma";
import { 
  ImportEntry, 
  normalizeStatus, 
  reconcileEntry, 
  normalizeTitle, 
  extractPlatformIds 
} from "./shared";
import { syncSourceQueue, seriesResolutionQueue } from "@/lib/queues";

function inferSourceName(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('mangadex')) return 'mangadex';
    if (host.includes('mangapark')) return 'mangapark';
    if (host.includes('mangasee')) return 'mangasee';
    if (host.includes('manga4life')) return 'mangasee';
    return 'imported';
  } catch {
    return 'imported';
  }
}

export async function processImportJob(jobId: string) {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    include: { 
      user: true,
      items: true
    }
  });

  if (!job || job.status !== "pending") return;

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "processing" }
  });

  // 1. COLLECT DATA FOR BATCHING
  const titles = new Set<string>();
  const normalizedTitles = new Set<string>();
  const mangadexIds = new Set<string>();
  const sourceUrls = new Set<string>();
  const sourceKeys: Array<{ name: string, id: string }> = [];
  
  const itemsWithMetadata = job.items.map(item => {
    const entry = item.metadata as unknown as ImportEntry;
    let sourceUrl = entry.source_url || entry.external_id;
    if (!sourceUrl && entry.title) {
      sourceUrl = `title-only:${Buffer.from(entry.title).toString('base64')}`;
    }
    
    const effectiveSourceName = (entry.source_name || inferSourceName(sourceUrl || "")).toLowerCase();
    const sourceId = entry.external_id || sourceUrl || "";

    if (entry.title) {
      titles.add(entry.title);
      normalizedTitles.add(normalizeTitle(entry.title));
    }

    if (sourceUrl) {
      sourceUrls.add(sourceUrl);
      const platformInfo = extractPlatformIds(sourceUrl);
      if (platformInfo?.platform === 'mangadex') {
        mangadexIds.add(platformInfo.id);
      }
      sourceKeys.push({ name: effectiveSourceName, id: sourceId });
    }

    return { item, entry, sourceUrl, effectiveSourceName, sourceId };
  });

  // 2. BATCH PREFETCH
  const [matchingSeries, existingLibEntries, existingSources] = await Promise.all([
    prisma.series.findMany({
      where: {
        OR: [
          { mangadex_id: { in: Array.from(mangadexIds) } },
          { title: { in: Array.from(titles), mode: 'insensitive' } },
          { title: { in: Array.from(normalizedTitles), mode: 'insensitive' } },
          // Aliases prefetch - using array_contains for each title
          ...Array.from(titles).map(t => ({ alternative_titles: { array_contains: t } }))
        ]
      }
    }),
    prisma.libraryEntry.findMany({
      where: {
        user_id: job.user_id,
        source_url: { in: Array.from(sourceUrls) }
      }
    }),
    prisma.seriesSource.findMany({
      where: {
        OR: sourceKeys.map(k => ({
          source_name: k.name,
          source_id: k.id
        }))
      }
    })
  ]);

  // 3. INDEXING FOR FAST LOOKUP
  const seriesByMdId = new Map(matchingSeries.filter(s => s.mangadex_id).map(s => [s.mangadex_id, s]));
  const seriesByTitle = new Map(matchingSeries.map(s => [s.title.toLowerCase(), s]));
  const seriesByNormTitle = new Map(matchingSeries.map(s => [normalizeTitle(s.title), s]));
  
  const libEntriesByUrl = new Map(existingLibEntries.map(e => [e.source_url, e]));
  const sourcesByKey = new Map(existingSources.map(s => [`${s.source_name}:${s.source_id}`, s]));

  const results = { matched: 0, failed: 0 };
  const libEntryCreates: any[] = [];
  const libEntryUpdates: any[] = [];
  const sourceCreates: any[] = [];
  const itemUpdates: any[] = [];
  const resolutionJobs: any[] = [];

  const pendingSources = new Set<string>();

  // 4. PROCESS ITEMS IN-MEMORY
  for (const { item, entry, sourceUrl, effectiveSourceName, sourceId } of itemsWithMetadata) {
    try {
      if (!sourceUrl) throw new Error("Missing source information");

      let matchedSeriesId = null;
      let confidence: "high" | "medium" | "none" = "none";

      const platformInfo = extractPlatformIds(sourceUrl);
      if (platformInfo?.platform === 'mangadex') {
        const s = seriesByMdId.get(platformInfo.id);
        if (s) {
          matchedSeriesId = s.id;
          confidence = "high";
        }
      }

      if (!matchedSeriesId && entry.title) {
        const s = seriesByTitle.get(entry.title.toLowerCase()) || seriesByNormTitle.get(normalizeTitle(entry.title));
        if (s) {
          matchedSeriesId = s.id;
          confidence = "high";
        } else {
          const aliasMatch = matchingSeries.find(s => s.alternative_titles.includes(entry.title));
          if (aliasMatch) {
            matchedSeriesId = aliasMatch.id;
            confidence = "medium";
          }
        }
      }

      const needsReview = confidence !== "high";
      const normStatus = normalizeStatus(entry.status);
      const existingEntry = libEntriesByUrl.get(sourceUrl);

      if (existingEntry) {
        const reconciliation = reconcileEntry(
          { 
            status: existingEntry.status, 
            progress: Number(existingEntry.last_read_chapter || 0),
            last_updated: existingEntry.updated_at
          },
          { 
            status: normStatus, 
            progress: entry.progress,
            last_updated: entry.last_updated
          }
        );

        if (reconciliation.shouldUpdate && reconciliation.updateData) {
          libEntryUpdates.push({
            id: existingEntry.id,
            data: {
              status: reconciliation.updateData.status || existingEntry.status,
              last_read_chapter: reconciliation.updateData.progress !== undefined ? reconciliation.updateData.progress : existingEntry.last_read_chapter,
              series_id: matchedSeriesId || existingEntry.series_id,
              needs_review: needsReview,
              updated_at: new Date()
            }
          });
        }
      } else {
        libEntryCreates.push({
          user_id: job.user_id,
          source_url: sourceUrl,
          source_name: effectiveSourceName,
          imported_title: entry.title,
          status: normStatus,
          last_read_chapter: entry.progress,
          series_id: matchedSeriesId || undefined,
          needs_review: needsReview,
          metadata_status: matchedSeriesId ? 'enriched' : 'pending',
          added_at: new Date()
        });
      }

      const sourceKey = `${effectiveSourceName}:${sourceId}`;
      const existingSource = sourcesByKey.get(sourceKey);
      
      if (!existingSource && !pendingSources.has(sourceKey)) {
        sourceCreates.push({
          source_name: effectiveSourceName,
          source_id: sourceId,
          source_url: sourceUrl,
          source_title: entry.title,
          sync_priority: "HOT"
        });
        pendingSources.add(sourceKey);
      }

      itemUpdates.push({
        id: item.id,
        status: "SUCCESS",
        matchedSeriesId,
        needsReview
      });
      
      results.matched++;
    } catch (error: any) {
      results.failed++;
      itemUpdates.push({
        id: item.id,
        status: "FAILED",
        error: error.message
      });
    }
  }

    // 5. TRANSACTIONAL PERSISTENCE (Optimized)
    await prisma.$transaction(async (tx) => {
      // 5.1 Create missing SeriesSources
      if (sourceCreates.length > 0) {
        await tx.seriesSource.createMany({
          data: sourceCreates,
          skipDuplicates: true
        });
      }

      // 5.2 Create new LibraryEntries in bulk
      if (libEntryCreates.length > 0) {
        const newEntries = await tx.libraryEntry.createManyAndReturn({
          data: libEntryCreates,
          skipDuplicates: true
        });

        for (const entry of newEntries) {
          if (!entry.series_id || entry.needs_review) {
            resolutionJobs.push({
              name: `enrich-${entry.id}`,
              data: { 
                libraryEntryId: entry.id, 
                source_url: entry.source_url, 
                title: entry.imported_title 
              },
              opts: { jobId: `enrich-${entry.id}`, priority: 2, removeOnComplete: true }
            });
          }
        }
      }

      // 5.3 Update existing LibraryEntries (Parallelized with Chunks)
      if (libEntryUpdates.length > 0) {
        const CHUNK_SIZE = 50;
        for (let i = 0; i < libEntryUpdates.length; i += CHUNK_SIZE) {
          const chunk = libEntryUpdates.slice(i, i + CHUNK_SIZE);
          await Promise.all(chunk.map(op => 
            tx.libraryEntry.update({ 
              where: { id: op.id }, 
              data: op.data 
            })
          ));
        }

        for (const op of libEntryUpdates) {
          if (!op.data.series_id || op.data.needs_review) {
            resolutionJobs.push({
              name: `enrich-${op.id}`,
              data: { 
                libraryEntryId: op.id, 
                source_url: op.source_url, 
                title: op.data.imported_title 
              },
              opts: { jobId: `enrich-${op.id}`, priority: 2, removeOnComplete: true }
            });
          }
        }
      }

      // 5.4 Update ImportItems (Optimized with grouped updateMany)
      if (itemUpdates.length > 0) {
        const successWithMatch = itemUpdates.filter(u => u.status === "SUCCESS" && u.matchedSeriesId && !u.needsReview).map(u => u.id);
        const successWithReview = itemUpdates.filter(u => u.status === "SUCCESS" && u.matchedSeriesId && u.needsReview).map(u => u.id);
        const successPendingEnrich = itemUpdates.filter(u => u.status === "SUCCESS" && !u.matchedSeriesId).map(u => u.id);
        const failedItems = itemUpdates.filter(u => u.status === "FAILED");

        if (successWithMatch.length > 0) {
          await tx.importItem.updateMany({
            where: { id: { in: successWithMatch } },
            data: { status: "SUCCESS", reason_message: "Matched." }
          });
        }
        if (successWithReview.length > 0) {
          await tx.importItem.updateMany({
            where: { id: { in: successWithReview } },
            data: { status: "SUCCESS", reason_message: "Matched. Needs review." }
          });
        }
        if (successPendingEnrich.length > 0) {
          await tx.importItem.updateMany({
            where: { id: { in: successPendingEnrich } },
            data: { status: "SUCCESS", reason_message: "Enrichment queued." }
          });
        }
        
        // Group failed items by error message to use updateMany
        if (failedItems.length > 0) {
          const failuresByMessage = new Map<string, string[]>();
          for (const item of failedItems) {
            const msg = item.error || "Unknown error";
            if (!failuresByMessage.has(msg)) failuresByMessage.set(msg, []);
            failuresByMessage.get(msg)!.push(item.id);
          }

          for (const [msg, ids] of failuresByMessage.entries()) {
            await tx.importItem.updateMany({
              where: { id: { in: ids } },
              data: { status: "FAILED", reason_message: msg }
            });
          }
        }
      }

      // 5.5 Final Job Update
      await tx.importJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          processed_items: job.items.length,
          matched_items: results.matched,
          failed_items: results.failed,
          completed_at: new Date()
        }
      });
    });

  // 6. BATCH QUEUE ENQUEUEING
  const finalSources = await prisma.seriesSource.findMany({
    where: {
      OR: sourceKeys.map(k => ({
        source_name: k.name,
        source_id: k.id
      }))
    }
  });

  const syncQueueJobs = finalSources.map(s => ({
    name: `sync-${s.id}`,
    data: { seriesSourceId: s.id },
    opts: { jobId: `sync-${s.id}`, priority: 1, removeOnComplete: true }
  }));

  const uniqueResolutionJobs = Array.from(new Map(resolutionJobs.map(j => [j.name, j])).values());

  await Promise.all([
    syncSourceQueue.addBulk(syncQueueJobs),
    seriesResolutionQueue.addBulk(uniqueResolutionJobs)
  ]);

  await prisma.auditLog.create({
    data: {
      user_id: job.user_id,
      event: "library_import_completed",
      status: "success",
      metadata: { job_id: jobId, matched: results.matched, failed: results.failed }
    }
  });
}
