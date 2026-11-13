import { describe, it, expect } from 'vitest'
import { getSafeAuthErrorMessage, mapSupabaseErrorToCode } from '@/lib/utils/auth'

describe('getSafeAuthErrorMessage', () => {
  it('returns appropriate friendly messages for known error codes', () => {
    expect(getSafeAuthErrorMessage('invalid_credentials')).toContain('Invalid email or password')
    expect(getSafeAuthErrorMessage('weak_password')).toContain('at least 8 characters')
    expect(getSafeAuthErrorMessage('user_exists')).toContain('already exists')
    expect(getSafeAuthErrorMessage('auth_callback_failed')).toContain('confirmation link may be expired')
  })

  it('falls back to generic error message for unknown or malicious codes', () => {
    expect(getSafeAuthErrorMessage('unexpected_leak_string')).toBe(
      'An unexpected authentication error occurred. Please try again.',
    )
    expect(getSafeAuthErrorMessage('<script>alert(1)</script>')).toBe(
      'An unexpected authentication error occurred. Please try again.',
    )
  })

  it('returns null for null, undefined, or empty values', () => {
    expect(getSafeAuthErrorMessage(null)).toBeNull()
    expect(getSafeAuthErrorMessage(undefined)).toBeNull()
    expect(getSafeAuthErrorMessage('')).toBeNull()
  })
})

describe('mapSupabaseErrorToCode', () => {
  it('maps credentials error correctly', () => {
    expect(mapSupabaseErrorToCode('Invalid login credentials')).toBe('invalid_credentials')
  })

  it('maps already registered user error', () => {
    expect(mapSupabaseErrorToCode('User already registered', true)).toBe('user_exists')
  })

  it('maps weak password error', () => {
    expect(mapSupabaseErrorToCode('Password should be at least 8 characters', true)).toBe('weak_password')
  })

  it('defaults to safe codes for unexpected messages', () => {
    expect(mapSupabaseErrorToCode('Database connection refused at 10.0.0.1')).toBe('invalid_credentials')
    expect(mapSupabaseErrorToCode('Internal Postgres error', true)).toBe('signup_failed')
  })
})
