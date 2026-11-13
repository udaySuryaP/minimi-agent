// src/app/auth/callback/route.ts
// Supabase Auth callback — exchanges the auth code for a session.
// Called after email confirmation or OAuth redirect.
// Sanitizes the post-authentication redirect destination against open redirects.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSafeRedirectUrl } from '@/lib/utils/url'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const rawRedirectTo = searchParams.get('redirectTo')
  const safeNext = getSafeRedirectUrl(rawRedirectTo, '/chat')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`)
    }
    console.error('[auth/callback failure]', { message: error.message })
  }

  // Auth failed — redirect to login with a safe error code
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
