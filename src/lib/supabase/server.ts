// src/lib/supabase/server.ts
// Server-side Supabase client — reads the session from cookies.
// Use in Server Components, Route Handlers, and Server Actions.
// Always uses the publishable key + user JWT so RLS is enforced.
// Never expose SUPABASE_SECRET_KEY here.

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from './types'
import { getSupabaseEnv } from './env'

export async function createClient() {
  const env = getSupabaseEnv()
  const cookieStore = await cookies()

  return createServerClient<Database>(
    env.url,
    env.publishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // setAll is called from Server Components where cookies are read-only.
            // This is safe to ignore — the proxy.ts handles cookie refresh.
          }
        },
      },
    },
  )
}
