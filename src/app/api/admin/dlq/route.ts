import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { prisma } from "@/lib/prisma"
import { handleApiError, ApiError, ErrorCodes, getClientIp, parsePaginationParams, checkRateLimit, validateUUID, validateOrigin, validateContentType, validateJsonSize } from "@/lib/api-utils"
import { z } from "zod"

// SECURITY: Schema for validating POST body
const DLQActionSchema = z.object({
  failureId: z.string().uuid("Invalid failure ID format"),
  action: z.enum(['resolve', 'delete'], { errorMap: () => ({ message: 'Invalid action. Must be "resolve" or "delete"' }) }),
});

export async function GET(request: NextRequest) {
  try {
    // SECURITY: Rate limiting for admin endpoints
    const ip = getClientIp(request);
    if (!await checkRateLimit(`admin-dlq:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    // Check for admin status via subscription_tier
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { subscription_tier: true }
    })

    if (dbUser?.subscription_tier !== 'admin') {
      throw new ApiError("Forbidden: Admin access required", 403, ErrorCodes.FORBIDDEN)
    }

    const { limit, offset } = parsePaginationParams(request.nextUrl.searchParams)

    const [failures, total] = await Promise.all([
      prisma.workerFailure.findMany({
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.workerFailure.count()
    ])

    return NextResponse.json({
      failures,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    })
  } catch (error) {
    return handleApiError(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    // SECURITY: CSRF protection
    validateOrigin(request);
    
    // SECURITY: Content-Type validation
    validateContentType(request);
    
    // SECURITY: Payload size validation
    await validateJsonSize(request, 1024); // 1KB max for this simple endpoint
    
    // SECURITY: Rate limiting for admin endpoints
    const ip = getClientIp(request);
    if (!await checkRateLimit(`admin-dlq-action:${ip}`, 20, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { subscription_tier: true }
    })

    if (dbUser?.subscription_tier !== 'admin') {
      throw new ApiError("Forbidden: Admin access required", 403, ErrorCodes.FORBIDDEN)
    }

    // SECURITY: Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST);
    }

    // SECURITY: Validate against schema
    const validatedBody = DLQActionSchema.safeParse(body);
    if (!validatedBody.success) {
      throw new ApiError(validatedBody.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }

    const { failureId, action } = validatedBody.data;

    // SECURITY: Additional UUID validation
    validateUUID(failureId, 'failureId');

    if (action === 'resolve') {
      const updated = await prisma.workerFailure.update({
        where: { id: failureId },
        data: { resolved_at: new Date() }
      })
      return NextResponse.json(updated)
    }

    if (action === 'delete') {
      await prisma.workerFailure.delete({
        where: { id: failureId }
      })
      return NextResponse.json({ success: true })
    }

    // This should never be reached due to schema validation, but kept for safety
    throw new ApiError("Invalid action", 400, ErrorCodes.BAD_REQUEST)
  } catch (error) {
    return handleApiError(error)
  }
}
