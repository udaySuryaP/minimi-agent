// src/lib/supabase/env.ts
// Validates and exports required Supabase environment variables.
// Avoids silent undefined runtime bugs from bare non-null assertions (!).

import { AppError } from '@/lib/utils/errors'

export interface SupabaseEnv {
  url: string
  publishableKey: string
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()

  const missing: string[] = []
  if (!url) {
    missing.push('NEXT_PUBLIC_SUPABASE_URL')
  }
  if (!publishableKey) {
    missing.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  }

  if (missing.length > 0) {
    throw new AppError(
      `Missing required Supabase environment configuration: ${missing.join(', ')}`,
      'CONFIG_ERROR',
      500,
    )
  }

  return {
    url: url!,
    publishableKey: publishableKey!,
  }
}
