import { describe, it, expect } from 'vitest'
import { isValidTimezone, sanitizeTimezone } from '@/lib/utils/timezone'

describe('isValidTimezone', () => {
  it('validates common IANA timezones', () => {
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('Asia/Kolkata')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('Europe/London')).toBe(true)
    expect(isValidTimezone('Asia/Tokyo')).toBe(true)
    expect(isValidTimezone('Australia/Sydney')).toBe(true)
  })

  it('rejects invalid, fictional, or malformed timezones', () => {
    expect(isValidTimezone('Fake/Zone')).toBe(false)
    expect(isValidTimezone('Invalid')).toBe(false)
    expect(isValidTimezone('GMT+5:30')).toBe(false) // Not a valid IANA identifier
    expect(isValidTimezone('UTC+1')).toBe(false)
  })

  it('rejects malicious or injection strings', () => {
    expect(isValidTimezone('<script>alert(1)</script>')).toBe(false)
    expect(isValidTimezone("'; DROP TABLE profiles; --")).toBe(false)
    expect(isValidTimezone('Asia/Kolkata\0evil')).toBe(false)
  })

  it('rejects non-string and empty values', () => {
    expect(isValidTimezone(null)).toBe(false)
    expect(isValidTimezone(undefined)).toBe(false)
    expect(isValidTimezone('')).toBe(false)
    expect(isValidTimezone('   ')).toBe(false)
    expect(isValidTimezone(123)).toBe(false)
    expect(isValidTimezone({})).toBe(false)
  })
})

describe('sanitizeTimezone', () => {
  it('returns valid timezones as-is', () => {
    expect(sanitizeTimezone('Asia/Kolkata')).toBe('Asia/Kolkata')
    expect(sanitizeTimezone('UTC')).toBe('UTC')
    expect(sanitizeTimezone('America/Los_Angeles')).toBe('America/Los_Angeles')
  })

  it('trims whitespace around valid timezones', () => {
    expect(sanitizeTimezone('  Europe/Berlin  ')).toBe('Europe/Berlin')
  })

  it('falls back to Asia/Kolkata when given invalid or untrusted inputs', () => {
    expect(sanitizeTimezone('Not/Real')).toBe('Asia/Kolkata')
    expect(sanitizeTimezone(null)).toBe('Asia/Kolkata')
    expect(sanitizeTimezone(undefined)).toBe('Asia/Kolkata')
    expect(sanitizeTimezone('')).toBe('Asia/Kolkata')
    expect(sanitizeTimezone('<script>')).toBe('Asia/Kolkata')
  })

  it('uses custom fallback when provided', () => {
    expect(sanitizeTimezone('BadZone', 'UTC')).toBe('UTC')
    expect(sanitizeTimezone(null, 'America/Chicago')).toBe('America/Chicago')
  })
})
