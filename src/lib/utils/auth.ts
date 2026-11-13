// src/lib/utils/auth.ts
// Safe user-facing authentication error handling.
// Prevents exposing raw database/Supabase error strings to users or URL parameters.

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password. Please check your credentials and try again.',
  weak_password: 'Password is too weak. Please use at least 8 characters.',
  user_exists: 'An account with this email address already exists. Please sign in instead.',
  auth_callback_failed: 'Authentication failed. The confirmation link may be expired or already used.',
  session_expired: 'Your session has expired. Please sign in again.',
  auth_required: 'Please sign in to access this page.',
  signup_failed: 'Unable to create your account. Please verify your details and try again.',
  auth_error: 'An unexpected authentication error occurred. Please try again.',
}

/**
 * Returns a safe, user-friendly error message given a known error code.
 * Falls back to a safe generic message if code is unknown, empty, or malicious.
 */
export function getSafeAuthErrorMessage(code: string | null | undefined): string | null {
  if (!code || typeof code !== 'string') {
    return null
  }

  const normalized = code.trim().toLowerCase()
  return AUTH_ERROR_MESSAGES[normalized] ?? AUTH_ERROR_MESSAGES.auth_error
}

/**
 * Maps a caught Supabase Auth error to a safe internal error code.
 * Used by server actions to determine safe redirect query parameters.
 */
export function mapSupabaseErrorToCode(errorMessage: string, isSignUp = false): string {
  const lower = errorMessage.toLowerCase()

  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'invalid_credentials'
  }

  if (lower.includes('already registered') || lower.includes('user already exists')) {
    return 'user_exists'
  }

  if (lower.includes('password') && (lower.includes('short') || lower.includes('weak') || lower.includes('least'))) {
    return 'weak_password'
  }

  return isSignUp ? 'signup_failed' : 'invalid_credentials'
}

export type AuthDiagnosticEvent = 'login_failure' | 'signup_failure' | 'callback_failure'

export interface AuthDiagnosticPayload {
  event: AuthDiagnosticEvent
  code: string
  status?: number
}

/**
 * Logs structured authentication diagnostics on the server.
 * Strips raw error messages, credentials, tokens, and provider messages.
 * Only logs fixed event identifiers, safe mapped error codes, and HTTP status codes.
 */
export function logAuthDiagnostic(event: AuthDiagnosticEvent, code: string, status?: number): void {
  const payload: AuthDiagnosticPayload = {
    event,
    code,
    ...(status !== undefined ? { status } : {}),
  }
  console.error(`[auth:${event}]`, payload)
}
