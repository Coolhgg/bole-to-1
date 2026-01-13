import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes, validateOrigin, validateContentType, validateJsonSize, logSecurityEvent, validateUUID } from "@/lib/api-utils"
import { createClient } from "@/lib/supabase/server"
import { importQueue } from "@/lib/queues"

export async function POST(request: NextRequest) {
  try {
    // CSRF Protection
    validateOrigin(request);

    // Content-Type & Size validation
    validateContentType(request);
    await validateJsonSize(request, 1024 * 1024); // 1MB limit for import payloads

    const ip = getClientIp(request);
    if (!await checkRateLimit(`library-import:${ip}`, 5, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    const { source, entries } = await request.clone().json();

    if (!source || !entries || !Array.isArray(entries)) {
      throw new ApiError("Invalid import data", 400, ErrorCodes.INVALID_INPUT);
    }

    // DoS Prevention: limit entries length
    if (entries.length > 500) {
      throw new ApiError("Too many entries. Maximum 500 allowed per import.", 400, ErrorCodes.VALIDATION_ERROR);
    }

    // OPTIMIZATION: Deduplicate entries and check against existing library
    // 1. Deduplicate by functional keys (URL, ID, Title)
    const uniqueEntriesMap = new Map();
    for (const entry of entries) {
      const key = entry.source_url || entry.external_id || entry.title;
      if (key && !uniqueEntriesMap.has(key)) {
        uniqueEntriesMap.set(key, entry);
      }
    }
    const deduplicatedEntries = Array.from(uniqueEntriesMap.values());

    // 2. Fetch existing library entries for this user to avoid re-importing
    const existingUrls = await prisma.libraryEntry.findMany({
      where: { 
        user_id: user.id,
        source_url: { in: deduplicatedEntries.map(e => e.source_url).filter(Boolean) }
      },
      select: { source_url: true }
    });
    const existingUrlSet = new Set(existingUrls.map(e => e.source_url));

    const finalEntries = deduplicatedEntries.filter(entry => 
      !entry.source_url || !existingUrlSet.has(entry.source_url)
    );

    if (finalEntries.length === 0 && deduplicatedEntries.length > 0) {
      return NextResponse.json({ 
        success: true, 
        message: "All items in this import are already in your library." 
      });
    }

    // Create the import job and items
    const job = await prisma.importJob.create({
      data: {
        user_id: user.id,
        source: source,
        status: "pending",
        total_items: finalEntries.length,
        processed_items: 0,
        matched_items: 0,
        failed_items: 0,
        items: {
          create: finalEntries.map((entry: any) => ({
            title: entry.title || "Unknown Title",
            status: "PENDING",
            metadata: entry
          }))
        }
      }
    });

    // Log security event
    await logSecurityEvent({
      userId: user.id,
      event: 'LIBRARY_IMPORT_START',
      status: 'success',
      ipAddress: ip,
      userAgent: request.headers.get('user-agent'),
      metadata: { 
        job_id: job.id, 
        source, 
        entry_count: finalEntries.length, 
        duplicate_count: deduplicatedEntries.length - finalEntries.length,
        original_count: entries.length 
      }
    });

    // Add job to BullMQ queue for robust background processing
    await importQueue.add('process-import', { 
      jobId: job.id 
    }, {
      jobId: `import_${job.id}`,
      removeOnComplete: true
    });

    return NextResponse.json({ 
      success: true, 
      job_id: job.id,
      message: deduplicatedEntries.length < entries.length 
        ? `Import started (${deduplicatedEntries.length} unique items, ${entries.length - deduplicatedEntries.length} duplicates skipped)`
        : "Import started" 
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("id");

      if (jobId) {
        validateUUID(jobId, 'id');
        const job = await prisma.importJob.findUnique({
          where: { id: jobId, user_id: user.id }
        });
        
        if (!job) {
          throw new ApiError("Import job not found", 404, ErrorCodes.NOT_FOUND);
        }
        
        return NextResponse.json(job);
      }

      const jobs = await prisma.importJob.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: "desc" },
        take: 10
      });

    return NextResponse.json(jobs);
  } catch (error) {
    return handleApiError(error);
  }
}
