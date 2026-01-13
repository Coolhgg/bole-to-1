import { NextRequest, NextResponse } from "next/server"
import { isWhitelistedDomain, isInternalIP, ALLOWED_CONTENT_TYPES, MAX_IMAGE_SIZE } from "@/lib/constants/image-whitelist"
import { checkRateLimit, ApiError, ErrorCodes, handleApiError, getClientIp } from "@/lib/api-utils"
import { initDNS } from "@/lib/dns-init"
import dns from "node:dns/promises"

// Initialize DNS servers (Google DNS fallback)
initDNS();

const CACHE_DURATION = 60 * 60 * 24 * 7

export async function GET(request: NextRequest) {
  try {
    // Rate limit: 500 requests per minute per IP to handle bursts during library imports
    const ip = getClientIp(request);
    if (!await checkRateLimit(`image-proxy:${ip}`, 500, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED)
    }

    const url = request.nextUrl.searchParams.get('url')

    if (!url) {
      throw new ApiError('Missing url parameter', 400, ErrorCodes.BAD_REQUEST)
    }

    let decodedUrl: string
    try {
      decodedUrl = decodeURIComponent(url)
    } catch {
      throw new ApiError('Invalid URL encoding', 400, ErrorCodes.BAD_REQUEST)
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(decodedUrl)
    } catch {
      throw new ApiError('Invalid URL format', 400, ErrorCodes.BAD_REQUEST)
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new ApiError('Invalid protocol. Only HTTP/HTTPS allowed', 400, ErrorCodes.BAD_REQUEST)
    }

    // SSRF DEFENSE PHASE 1: Static hostname check
    if (isInternalIP(parsedUrl.hostname)) {
      throw new ApiError('Internal addresses are not allowed', 403, ErrorCodes.FORBIDDEN)
    }

    if (!isWhitelistedDomain(decodedUrl)) {
      throw new ApiError(`Domain not whitelisted: ${parsedUrl.hostname}`, 403, ErrorCodes.FORBIDDEN)
    }

    // SSRF DEFENSE PHASE 2: DNS Resolution check
    // Resolves the hostname and checks if the resulting IP is internal
    try {
      const lookup = await dns.lookup(parsedUrl.hostname)
      if (lookup.address && isInternalIP(lookup.address)) {
        throw new ApiError('Destination resolves to an internal address', 403, ErrorCodes.FORBIDDEN)
      }
    } catch (dnsErr) {
      console.warn(`[ImageProxy] DNS lookup failed for ${parsedUrl.hostname}:`, dnsErr)
      // We continue if DNS fails as fetch might still work with system resolver, 
      // but phase 1 static check still protects us.
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    // MangaDex requires https://mangadex.org as Referer to avoid anti-hotlinking
    const referer = parsedUrl.hostname.includes('mangadex.org')
      ? 'https://mangadex.org/'
      : parsedUrl.origin

    const response = await fetch(decodedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': referer,
        'Origin': referer,
      },
    }).catch(err => {
      console.warn(`[ImageProxy] Fetch failed for ${decodedUrl}:`, err.message);
      throw new ApiError(`Upstream connection failed: ${err.message}`, 502, ErrorCodes.INTERNAL_ERROR);
    })

    clearTimeout(timeout)

    if (!response || !response.ok) {
      throw new ApiError(`Failed to fetch image: ${response?.status || 'Unknown'}`, response?.status || 502, ErrorCodes.INTERNAL_ERROR)
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || ''
    const isValidType = ALLOWED_CONTENT_TYPES.some(type => 
      contentType.includes(type.replace('image/', ''))
    )

    if (!isValidType) {
      throw new ApiError(`Invalid content type: ${contentType}`, 415, ErrorCodes.VALIDATION_ERROR)
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0')
    if (contentLength > MAX_IMAGE_SIZE) {
      throw new ApiError(`Image too large. Max size: ${MAX_IMAGE_SIZE} bytes`, 413, ErrorCodes.VALIDATION_ERROR)
    }

    return new NextResponse(response.body, {
      status: 200,
      headers: {
        'Content-Type': contentType || 'image/jpeg',
        ...(contentLength > 0 ? { 'Content-Length': contentLength.toString() } : {}),
        'Cache-Control': `public, max-age=${CACHE_DURATION}, immutable`,
        'X-Proxy-Cache': 'HIT',
        'X-Original-URL': parsedUrl.hostname,
        'X-Content-Type-Options': 'nosniff',
      },
    })

  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return handleApiError(new ApiError('Request timeout', 504, ErrorCodes.INTERNAL_ERROR))
    }

    if (error instanceof ApiError) {
      return handleApiError(error)
    }

    console.error('Image proxy error:', error)
    return handleApiError(new ApiError('Failed to proxy image', 500, ErrorCodes.INTERNAL_ERROR))
  }
}
