import { describe, it, expect, vi } from 'vitest'
import { getSafeAuthErrorMessage, mapSupabaseErrorToCode, logAuthDiagnostic } from '@/lib/utils/auth'

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

describe('logAuthDiagnostic', () => {
  it('logs safe structured diagnostics without raw messages or secrets', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    logAuthDiagnostic('login_failure', 'invalid_credentials', 400)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith('[auth:login_failure]', {
      event: 'login_failure',
      code: 'invalid_credentials',
      status: 400,
    })

    logAuthDiagnostic('signup_failure', 'user_exists')
    expect(errorSpy).toHaveBeenCalledWith('[auth:signup_failure]', {
      event: 'signup_failure',
      code: 'user_exists',
    })

    logAuthDiagnostic('callback_failure', 'auth_callback_failed', 500)
    expect(errorSpy).toHaveBeenCalledWith('[auth:callback_failure]', {
      event: 'callback_failure',
      code: 'auth_callback_failed',
      status: 500,
    })

    errorSpy.mockRestore()
  })
})
