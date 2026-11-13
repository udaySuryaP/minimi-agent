// src/lib/utils/constants.ts
// Application-wide constants and validated runtime limits.

/**
 * Safely parses an integer environment variable, enforcing minimum and maximum bounds.
 * Falls back to defaultVal if undefined, unparseable, NaN, or out of bounds.
 */
export function parseBoundedInt(
  val: string | undefined,
  defaultVal: number,
  min: number,
  max: number,
): number {
  if (val === undefined || val === null || val === '') {
    return defaultVal
  }
  const parsed = Number.parseInt(String(val).trim(), 10)
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return defaultVal
  }
  return parsed
}

/** Maximum Tavily search calls per user turn (default: 8, bounds: 1 - 20) */
export const MAX_SEARCH_CALLS = parseBoundedInt(process.env.MAX_SEARCH_CALLS, 8, 1, 20)

/** Maximum results returned per Tavily call (default: 5, bounds: 1 - 10) */
export const MAX_RESULTS_PER_CALL = parseBoundedInt(process.env.MAX_RESULTS_PER_CALL, 5, 1, 10)

/** Per-call timeout for Tavily searches in milliseconds (default: 8000, bounds: 1000 - 30000) */
export const SEARCH_TIMEOUT_MS = parseBoundedInt(process.env.SEARCH_TIMEOUT_MS, 8_000, 1_000, 30_000)

/** Total search budget per user turn in milliseconds (default: 30000, bounds: 5000 - 120000) */
export const TOTAL_SEARCH_BUDGET_MS = parseBoundedInt(process.env.TOTAL_SEARCH_BUDGET_MS, 30_000, 5_000, 120_000)

/** Minimum Tavily relevance score to accept a result */
export const MIN_RELEVANCE_SCORE = 0.3

/** Date confidence threshold below which the agent asks for clarification */
export const DATE_CONFIDENCE_THRESHOLD = 0.6

/** Default fallback timezone when browser detection is unavailable */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata'
