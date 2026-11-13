// src/proxy.ts
// Next.js 16 auth guard — replaces middleware.ts (renamed in Next.js 16).
// Refreshes the Supabase session on every request.
// Redirects unauthenticated users away from protected routes.
// Redirects authenticated users away from auth pages.

import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'
import { matchesAnyPrefix } from '@/lib/utils/path'
import { getSafeRedirectUrl } from '@/lib/utils/url'

// Routes that require the user to be authenticated
const PROTECTED_PREFIXES = ['/chat', '/api/conversations', '/api/memory', '/api/research'] as const

// Routes that require the user to be unauthenticated (auth pages)
const AUTH_PREFIXES = ['/login', '/signup'] as const

export async function proxy(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request)
  const { pathname } = request.nextUrl

  // Exact-path and path-boundary matching to prevent overbroad matches like /chatty
  const isProtected = matchesAnyPrefix(pathname, PROTECTED_PREFIXES)
  const isAuthPage = matchesAnyPrefix(pathname, AUTH_PREFIXES)

  // Redirect unauthenticated users to login
  if (isProtected && !user) {
    const loginUrl = new URL('/login', request.url)
    const safeRedirect = getSafeRedirectUrl(pathname, '/chat')
    loginUrl.searchParams.set('redirectTo', safeRedirect)
    return NextResponse.redirect(loginUrl)
  }

  // Redirect authenticated users away from login/signup
  if (isAuthPage && user) {
    return NextResponse.redirect(new URL('/chat', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static  (bundled assets)
     * - _next/image   (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     * - public/       (static files)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
