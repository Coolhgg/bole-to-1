import { NextResponse } from 'next/server'
// The client you created from the Server-Side Auth instructions
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientIp, getSafeRedirect } from "@/lib/api-utils"

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // if "next" is in search params, use it as the redirection URL
  const next = getSafeRedirect(searchParams.get('next'), '/library')

  // SECURITY: Rate limit OAuth callback to prevent code brute-forcing (BUG 18)
  const ip = getClientIp(request)
  if (!await checkRateLimit(`oauth:${ip}`, 10, 60000)) {
    return NextResponse.redirect(`${origin}/auth/auth-code-error?error=rate_limited`)
  }

  if (code) {
    const supabase = await createClient()

    // BUG 77: Session fixation protection
    // Ensure we don't have an existing stale session before exchanging the code
    await supabase.auth.signOut();

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      const forwardedHost = request.headers.get('x-forwarded-host')
      const isLocalEnv = process.env.NODE_ENV === 'development'
      
      if (isLocalEnv) {
        return NextResponse.redirect(`${origin}${next}`)
      } else if (forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${next}`)
      } else {
        return NextResponse.redirect(`${origin}${next}`)
      }
    }
  }

  // return the user to an error page with instructions
  return NextResponse.redirect(`${origin}/auth/auth-code-error`)
}
