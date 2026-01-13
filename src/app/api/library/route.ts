import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { prisma } from '@/lib/prisma';
import { sanitizeInput, checkRateLimit, handleApiError, ApiError, ErrorCodes, validateOrigin, escapeILikePattern, getClientIp, logSecurityEvent, validateContentType, validateJsonSize, parsePaginationParams } from '@/lib/api-utils';
import { z } from 'zod';
import { isValidCoverUrl } from '@/lib/cover-resolver';
import { PRODUCTION_QUERIES } from '@/lib/sql/production-queries';
import { promoteSeriesTier } from '@/lib/catalog-tiers';

const AddToLibrarySchema = z.object({
  seriesId: z.string().uuid('Invalid series ID format'),
  status: z.enum(['reading', 'completed', 'planning', 'dropped', 'paused']).default('reading'),
});

const LibraryQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  sort: z.enum(['updated', 'latest_chapter', 'title', 'rating', 'added']).default('latest_chapter'),
  limit: z.preprocess((val) => {
    const num = parseInt(val as string, 10);
    if (isNaN(num)) return 100;
    return Math.min(200, Math.max(1, num));
  }, z.number()).default(100),
  offset: z.coerce.number().min(0).default(0),
});

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    const { searchParams } = new URL(req.url);
    const parsed = LibraryQuerySchema.safeParse(Object.fromEntries(searchParams));
    
    if (!parsed.success) {
      throw new ApiError(parsed.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }
    
    const { q, status, sort, limit, offset } = parsed.data;

    const where: any = {
      user_id: user.id,
      deleted_at: null,
    };

    if (status) {
      where.status = status;
    }

    if (q) {
      where.series = {
        title: {
          contains: q,
          mode: 'insensitive',
        },
      };
    }

    const orderBy: any = {};
    if (sort === 'title') {
      orderBy.series = { title: 'asc' };
    } else if (sort === 'rating') {
      orderBy.rating = 'desc';
    } else if (sort === 'added') {
      orderBy.created_at = 'desc';
    } else if (sort === 'latest_chapter') {
      orderBy.series = { last_chapter_date: 'desc' };
    } else {
      orderBy.updated_at = 'desc';
    }

    const [items, filteredTotal, totalCount, statusCounts] = await prisma.$transaction([
      prisma.libraryEntry.findMany({
        where,
        select: {
          id: true,
          series_id: true,
          status: true,
          metadata_status: true,
          needs_review: true,
          source_url: true,
          imported_title: true,
          last_read_chapter: true,
          user_rating: true,
          updated_at: true,
          series: {
            select: {
              id: true,
              title: true,
              cover_url: true,
              type: true,
              status: true,
              content_rating: true,
            },
          },
        },
        orderBy,
        take: limit,
        skip: offset,
      }),
      prisma.libraryEntry.count({ where }),
      prisma.libraryEntry.count({ where: { user_id: user.id, deleted_at: null } }),
      prisma.libraryEntry.groupBy({
        by: ['status'],
        where: { user_id: user.id, deleted_at: null },
        _count: true,
      }),
    ]);

    const stats = {
      all: totalCount,
      reading: statusCounts.find(c => c.status === 'reading')?._count || 0,
      completed: statusCounts.find(c => c.status === 'completed')?._count || 0,
      planning: statusCounts.find(c => c.status === 'planning')?._count || 0,
      dropped: statusCounts.find(c => c.status === 'dropped')?._count || 0,
      paused: statusCounts.find(c => c.status === 'paused')?._count || 0,
    };

    return NextResponse.json({
      entries: items,
      stats,
      pagination: {
        total: filteredTotal,
        limit,
        offset,
        hasMore: offset + items.length < filteredTotal,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    // CSRF Protection
    validateOrigin(req);

    // BUG 58: Validate Content-Type
    validateContentType(req);

    // BUG 57: Validate JSON Size
    await validateJsonSize(req);

    if (!await checkRateLimit(`library-add:${user.id}`, 30, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }
    
    const validatedBody = AddToLibrarySchema.safeParse(body);
    if (!validatedBody.success) {
      throw new ApiError(validatedBody.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }

    const { seriesId, status } = validatedBody.data;

    // Check if series exists and get its primary source
    const series = await prisma.series.findUnique({
      where: { id: seriesId },
      include: { 
        sources: {
          take: 1,
          orderBy: { trust_score: 'desc' }
        } 
      }
    });

    if (!series) {
      throw new ApiError('Series not found', 404, ErrorCodes.NOT_FOUND);
    }

    const primarySource = series.sources[0];
    if (!primarySource) {
      throw new ApiError('Series has no associated sources. Cannot add to library.', 400, ErrorCodes.BAD_REQUEST);
    }

    // Create/Update library entry and increment follow count atomically
    const entry = await prisma.$transaction(async (tx) => {
      const existingEntry = await tx.libraryEntry.findUnique({
        where: {
          user_id_source_url: {
            user_id: user.id,
            source_url: primarySource.source_url,
          }
        },
        select: { id: true }
      });

      const entry = await tx.libraryEntry.upsert({
        where: {
          user_id_source_url: {
            user_id: user.id,
            source_url: primarySource.source_url,
          }
        },
        update: {
          series_id: seriesId,
          status: status,
        },
        create: {
          user_id: user.id,
          series_id: seriesId,
          source_url: primarySource.source_url,
          source_name: primarySource.source_name,
          status: status,
          last_read_chapter: 0,
          metadata_status: 'enriched',
        }
      });

      // Increment follow count only for NEW entries
      if (!existingEntry) {
        await tx.series.update({
          where: { id: seriesId },
          data: { total_follows: { increment: 1 } }
        });
        
        // KENMEI PARITY: Promote series tier on follow
        await promoteSeriesTier(seriesId, 'user_follow');
      }

      return entry;
    });
    
    // Log the event (Audit Logging enhancement)
    await logSecurityEvent({
      userId: user.id,
      event: 'LIBRARY_ADD',
      status: 'success',
      ipAddress: getClientIp(req),
      userAgent: req.headers.get('user-agent'),
      metadata: { series_id: seriesId, status }
    })

    return NextResponse.json(entry, { status: 201 });

  } catch (error: any) {
    console.error('Library add error:', error);
    return handleApiError(error);
  }
}
