// src/lib/utils/path.ts
// Path boundary and routing utilities.

/**
 * Checks if a pathname matches a target path prefix respecting path boundaries.
 *
 * Prevents overbroad prefix matching (e.g. `/chatty` matching `/chat`,
 * or `/signup-bonus` matching `/signup`).
 *
 * A path matches if:
 * 1. It is exactly equal to the prefix: `/chat` matches `/chat`
 * 2. It starts with the prefix followed by `/`: `/chat/123` matches `/chat`
 *
 * @param pathname The request pathname (e.g. '/chat/xyz').
 * @param prefix The path prefix to check against (e.g. '/chat').
 */
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (!pathname || !prefix) {
    return false
  }

  // Normalize prefix by stripping any trailing slash
  const cleanPrefix = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  if (pathname === cleanPrefix) {
    return true
  }

  if (cleanPrefix === '/') {
    return true
  }

  return pathname.startsWith(`${cleanPrefix}/`)
}

/**
 * Checks if a pathname matches any of the given path prefixes respecting path boundaries.
 */
export function matchesAnyPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => matchesPathPrefix(pathname, prefix))
}
