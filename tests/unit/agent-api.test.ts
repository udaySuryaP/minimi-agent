import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentRequestBody } from '@/lib/agent/request-body'

const apiMocks = vi.hoisted(() => ({ createClient: vi.fn(), getUser: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: apiMocks.createClient }))

import { POST } from '@/app/api/agent/route'

const userId = 'b879e41c-5110-485f-a9be-7cd85a2b8ad9'

function makeQuery(table: string) {
  const result = table === 'profiles'
    ? { data: { timezone: 'Asia/Kolkata' }, error: null }
    : { data: [], error: null }
  const query = {
    select() { return query },
    eq() { return query },
    gte() { return query },
    lt() { return query },
    or() { return query },
    textSearch() { return query },
    order() { return query },
    range() { return query },
    limit() { return query },
    in() { return query },
    maybeSingle() { return Promise.resolve(result) },
    then(resolve: (value: { data: unknown; error: null }) => unknown) { return Promise.resolve(result).then(resolve) },
  }
  return query
}

function validRequest(body: string) {
  return new Request('http://localhost/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
}

async function json(response: Response) { return response.json() as Promise<Record<string, unknown>> }

describe('agent API request boundary', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_MAX_REQUEST_BYTES', '128')
    vi.stubEnv('GEMINI_API_KEY', '')
    apiMocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
    apiMocks.createClient.mockResolvedValue({
      auth: { getUser: apiMocks.getUser },
      from: (table: string) => makeQuery(table),
    })
  })

  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

  it('rejects an oversized stream and cancels it before draining the body', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(129)) },
      cancel() { cancelled = true },
    })
    const request = new Request('http://localhost/api/agent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: stream,
      duplex: 'half',
    } as RequestInit)
    const response = await POST(request)
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(cancelled).toBe(true)
  })

  it('enforces the byte limit before authentication, including for unauthenticated requests', async () => {
    apiMocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await POST(validRequest(JSON.stringify({ query: 'x'.repeat(200) })))
    expect(response.status).toBe(413)
    expect(apiMocks.getUser).not.toHaveBeenCalled()
  })

  it('accepts a normal request without Content-Length', async () => {
    const request = validRequest(JSON.stringify({ query: 'hello' }))
    expect(request.headers.get('content-length')).toBeNull()
    const response = await POST(request)
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } })
  })

  it('ignores a malformed Content-Length hint and still enforces the stream limit', async () => {
    const request = new Request('http://localhost/api/agent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 'not-a-number' }, body: JSON.stringify({ query: 'hello' }),
    })
    expect(await readAgentRequestBody(request, 128)).toMatchObject({ ok: true })
  })

  it('counts multibyte UTF-8 bytes rather than characters', async () => {
    const request = validRequest(JSON.stringify({ query: '😀😀😀' }))
    expect(request.headers.get('content-length')).toBeNull()
    expect(await readAgentRequestBody(request, 20)).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('enforces the streamed byte cap when Content-Length is misleadingly small', async () => {
    const request = new Request('http://localhost/api/agent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' }, body: JSON.stringify({ query: 'x'.repeat(200) }),
    })
    expect(await readAgentRequestBody(request, 128)).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('rejects malformed UTF-8 instead of decoding it with replacement characters', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0xc3, 0x28])); controller.close() } })
    const request = new Request('http://localhost/api/agent', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(await readAgentRequestBody(request, 128)).toMatchObject({ ok: false, reason: 'invalid_json' })
  })

  it('maps interrupted request streams to a safe read failure', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private stream failure')) } })
    const request = new Request('http://localhost/api/agent', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(await readAgentRequestBody(request, 128)).toMatchObject({ ok: false, reason: 'read_failed' })
  })

  it('returns a structured error for malformed JSON', async () => {
    const response = await POST(validRequest('{'))
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
  })

  it('ignores a client timestamp and uses the server reference timestamp', async () => {
    const before = Date.now()
    const response = await POST(validRequest(JSON.stringify({ query: 'today', referenceTimestamp: '1900-01-01T00:00:00.000Z' })))
    const result = await json(response) as { temporal: { referenceTimestamp: string } }
    const actual = new Date(result.temporal.referenceTimestamp).getTime()
    expect(response.status).toBe(503)
    expect(actual).toBeGreaterThanOrEqual(before)
    expect(actual).toBeLessThanOrEqual(Date.now())
    expect(result.temporal.referenceTimestamp).not.toBe('1900-01-01T00:00:00.000Z')
  })

  it('returns 401 when the session has no authenticated user', async () => {
    apiMocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await POST(validRequest(JSON.stringify({ query: 'hello' })))
    expect(response.status).toBe(401)
    expect(await json(response)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('maps thrown auth-provider failures to a safe internal error', async () => {
    apiMocks.getUser.mockRejectedValue(new Error('private provider token detail'))
    const response = await POST(validRequest(JSON.stringify({ query: 'hello' })))
    expect(response.status).toBe(500)
    const body = JSON.stringify(await json(response))
    expect(body).toContain('INTERNAL_ERROR')
    expect(body).not.toContain('private provider token detail')
  })

  it('maps Supabase client creation failures to a safe internal error', async () => {
    apiMocks.createClient.mockRejectedValue(new Error('private Supabase configuration detail'))
    const response = await POST(validRequest(JSON.stringify({ query: 'hello' })))
    expect(response.status).toBe(500)
    const body = JSON.stringify(await json(response))
    expect(body).toContain('INTERNAL_ERROR')
    expect(body).not.toContain('private Supabase configuration detail')
  })

  it('maps retryable auth errors returned by Supabase to a safe internal error', async () => {
    apiMocks.getUser.mockResolvedValue({ data: { user: null }, error: Object.assign(new Error('private auth failure'), { status: 503 }) })
    const response = await POST(validRequest(JSON.stringify({ query: 'hello' })))
    expect(response.status).toBe(500)
    const body = JSON.stringify(await json(response))
    expect(body).toContain('INTERNAL_ERROR')
    expect(body).not.toContain('private auth failure')
  })
})
