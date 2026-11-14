export type ProviderFailureKind = 'rate_limited' | 'request_failed' | 'timeout'

export class ProviderRequestError extends Error {
  constructor(readonly kind: ProviderFailureKind, readonly retryAfterSeconds: number | null = null) {
    super(kind === 'rate_limited' ? 'Provider request was rate limited.' : kind === 'timeout' ? 'Provider request timed out.' : 'Provider request failed.')
    this.name = 'ProviderRequestError'
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null
  const retryAt = seconds === null ? Date.parse(value) : Number.NaN
  const delay = seconds ?? (Number.isFinite(retryAt) ? Math.ceil((retryAt - now) / 1000) : null)
  if (delay === null || !Number.isFinite(delay)) return null
  return Math.min(3600, Math.max(0, Math.floor(delay)))
}

export function providerHttpError(status: number, retryAfter: string | null, now = Date.now()): ProviderRequestError {
  return status === 429
    ? new ProviderRequestError('rate_limited', parseRetryAfter(retryAfter, now))
    : new ProviderRequestError('request_failed')
}

export function providerFailure(error: unknown): ProviderRequestError {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    ? new ProviderRequestError('timeout')
    : new ProviderRequestError('request_failed')
}
