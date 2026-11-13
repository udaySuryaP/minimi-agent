// src/lib/supabase/client.ts
// Browser-side Supabase client — uses the publishable key.
// Safe to call in Client Components and browser code.
// RLS is enforced on every query via the user's cookie-based JWT.

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './types'
import { getSupabaseEnv } from './env'

export function createClient() {
  const env = getSupabaseEnv()
  return createBrowserClient<Database>(env.url, env.publishableKey)
}
