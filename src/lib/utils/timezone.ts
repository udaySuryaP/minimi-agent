// src/lib/utils/timezone.ts
// IANA timezone validation and sanitization utilities.

/**
 * Validates whether a value is a valid, recognized IANA timezone identifier.
 * Uses the native Intl.DateTimeFormat API to verify against the system's timezone database.
 *
 * @param tz Value to test.
 * @returns boolean indicating if it is a valid IANA timezone identifier.
 */
export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string') {
    return false
  }

  const trimmed = tz.trim()
  if (!trimmed || trimmed.length > 50) {
    return false
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed })
    return true
  } catch {
    return false
  }
}

/**
 * Sanitizes an untrusted timezone string (e.g. from a form submission or client headers).
 * Returns the timezone if valid; otherwise returns the specified safe fallback.
 *
 * @param tz Untrusted timezone string.
 * @param fallback Default fallback timezone (default 'Asia/Kolkata').
 */
export function sanitizeTimezone(tz: unknown, fallback = 'Asia/Kolkata'): string {
  if (isValidTimezone(tz)) {
    return (tz as string).trim()
  }
  return fallback
}
