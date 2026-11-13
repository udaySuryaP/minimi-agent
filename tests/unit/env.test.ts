import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getSupabaseEnv } from '@/lib/supabase/env'
import { AppError } from '@/lib/utils/errors'

describe('getSupabaseEnv', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test-project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'
  })

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalKey
  })

  it('returns trimmed environment variables when set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = '  https://example.supabase.co  '
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = '  pub-key-123  '

    const env = getSupabaseEnv()
    expect(env.url).toBe('https://example.supabase.co')
    expect(env.publishableKey).toBe('pub-key-123')
  })

  it('returns placeholder values when both env vars are completely unset', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

    const env = getSupabaseEnv()
    expect(env.url).toBe('https://placeholder.supabase.co')
    expect(env.publishableKey).toBe('placeholder-publishable-key')
  })

  it('throws AppError when only NEXT_PUBLIC_SUPABASE_URL is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'valid-key'

    expect(() => getSupabaseEnv()).toThrow(AppError)
    expect(() => getSupabaseEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it('throws AppError when only NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

    expect(() => getSupabaseEnv()).toThrow(AppError)
    expect(() => getSupabaseEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/)
  })
})
