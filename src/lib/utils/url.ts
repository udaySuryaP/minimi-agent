// src/lib/utils/url.ts
// URL security and validation utilities.

/**
 * Validates and sanitizes a post-login redirect path.
 *
 * Prevents open redirect vulnerabilities by strictly allowing only safe,
 * same-origin internal paths. Rejects external URLs, protocol-relative URLs
 * (e.g. //evil.com), backslash tricks (e.g. /\evil.com, \\evil.com),
 * control characters, and malformed paths.
 *
 * @param target The untrusted redirect target from query param or form data.
 * @param fallback The safe default path to use if target is invalid (defaults to '/chat').
 * @returns A safe relative path string.
 */
export function getSafeRedirectUrl(target: string | null | undefined, fallback = '/chat'): string {
  if (!target || typeof target !== 'string') {
    return fallback
  }

  const trimmed = target.trim()
  if (!trimmed) {
    return fallback
  }

  // Must start with exactly one forward slash; reject double-slash, backslash, or protocol-relative
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/\\') ||
    trimmed.startsWith('\\')
  ) {
    return fallback
  }

  // Reject any backslash anywhere in the path (exploited in browser parser confusion)
  if (trimmed.includes('\\')) {
    return fallback
  }

  // Reject control characters and null bytes
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return fallback
  }

  // Reject malformed percent escapes (e.g. %ZZ, %2, lone %)
  // In a valid URI, every '%' must be followed by two hexadecimal digits.
  if (/%(?![0-9a-fA-F]{2})/.test(trimmed)) {
    return fallback
  }

  // Verify that percent escapes decode cleanly and do not introduce dangerous characters (e.g. %5C for \)
  try {
    const decoded = decodeURI(trimmed)
    if (decoded.includes('\\') || /[\u0000-\u001F\u007F]/.test(decoded)) {
      return fallback
    }
  } catch {
    // decodeURI throws URIError on malformed percent encoding
    return fallback
  }

  try {
    // Parse against a dummy local base to verify structure
    const parsed = new URL(trimmed, 'http://localhost')

    // Origin must remain the dummy local origin (no host injection)
    if (parsed.origin !== 'http://localhost') {
      return fallback
    }

    // Pathname must begin with /
    if (!parsed.pathname.startsWith('/')) {
      return fallback
    }

    // Return the safe relative path, preserving query and hash if present
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}
