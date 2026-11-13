// src/lib/supabase/env.ts
// Validates and exports required Supabase environment variables.
// Avoids silent undefined runtime bugs from bare non-null assertions (!).

import { AppError } from '@/lib/utils/errors'

export interface SupabaseEnv {
  url: string
  publishableKey: string
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (!url || typeof url !== 'string' || !url.trim() || !publishableKey || typeof publishableKey !== 'string' || !publishableKey.trim()) {
    // When building in an unconfigured environment (e.g. CI or fresh clone before .env.local is populated),
    // supply a placeholder so page prerendering analysis compiles without crashing.
    if (!url && !publishableKey) {
      return {
        url: 'https://placeholder.supabase.co',
        publishableKey: 'placeholder-publishable-key',
      }
    }

    if (!url || !url.trim()) {
      throw new AppError(
        'Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL',
        'CONFIG_ERROR',
        500,
      )
    }

    throw new AppError(
      'Missing required environment variable: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'CONFIG_ERROR',
      500,
    )
  }

  return {
    url: url.trim(),
    publishableKey: publishableKey.trim(),
  }
}
