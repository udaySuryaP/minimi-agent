import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRetryAfter, ProviderRequestError } from '@/lib/agent/provider-errors'

vi.mock('server-only', () => ({}))

import { GeminiHttpProvider, normalizePublishedDate, TavilyHttpProvider } from '@/lib/agent/providers'

describe('Tavily publication date normalization', () => {
  it('preserves date-only precision and normalizes offset timestamps to UTC', () => {
    expect(normalizePublishedDate('2026-11-03')).toEqual({ precision: 'date', value: '2026-11-03' })
    expect(normalizePublishedDate('2026-11-03T12:00:00+05:30')).toEqual({ precision: 'instant', value: '2026-11-03T06:30:00.000Z' })
  })

  it('returns null for missing or invalid publication dates without fabricating a timezone', () => {
    expect(normalizePublishedDate(null)).toBeNull()
    expect(normalizePublishedDate('2026-02-30')).toBeNull()
    expect(normalizePublishedDate('November 3, 2026')).toBeNull()
  })
})

describe('Tavily provider boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('accepts date-only dates, timestamps and missing dates from a mocked response', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [
      { title: 'Date', url: 'https://example.com/date', content: 'Summary', published_date: '2026-11-03' },
      { title: 'Instant', url: 'https://example.com/instant', content: 'Summary', published_date: '2026-11-03T12:00:00+05:30' },
      { title: 'No date', url: 'https://example.com/no-date', content: 'Summary' },
      { title: 'Bad date', url: 'https://example.com/bad-date', content: 'Summary', published_date: 'not a date' },
    ] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new TavilyHttpProvider().search('test query')
    expect(result.results.map(({ publishedAt }) => publishedAt)).toEqual([
      { precision: 'date', value: '2026-11-03' },
      { precision: 'instant', value: '2026-11-03T06:30:00.000Z' },
      null,
      null,
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('drops malformed URLs and retains valid results with missing title or content', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-only-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ results: [
      { title: 'Bad URL', url: 'javascript:alert(1)', content: 'ignored' },
      { url: 'https://example.com/valid' },
      null,
    ] })))
    const result = await new TavilyHttpProvider().search('test query')
    expect(result.results).toEqual([{ title: null, url: 'https://example.com/valid', snippet: '', publishedAt: null, score: null }])
  })

  it('returns bounded Retry-After metadata for 429 and does not retry automatically', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new TavilyHttpProvider().search('test query')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('handles other HTTP failures, timeouts and malformed responses with safe provider errors', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('not-json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new TavilyHttpProvider().search('test query')).rejects.toMatchObject({ kind: 'request_failed' })
    await expect(new TavilyHttpProvider().search('test query')).rejects.toMatchObject({ kind: 'request_failed' })

    fetchMock.mockRejectedValueOnce(new DOMException('private detail', 'TimeoutError'))
    await expect(new TavilyHttpProvider().search('test query')).rejects.toMatchObject({ kind: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('parses delta and HTTP-date Retry-After values with a one-hour cap', () => {
    const now = Date.parse('2026-11-13T00:00:00.000Z')
    expect(parseRetryAfter('45', now)).toBe(45)
    expect(parseRetryAfter('Fri, 13 Nov 2026 00:02:00 GMT', now)).toBe(120)
    expect(parseRetryAfter('99999', now)).toBe(3600)
    expect(parseRetryAfter('invalid', now)).toBeNull()
    expect(new ProviderRequestError('rate_limited', null)).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: null })
  })
})

describe('Gemini grounded answer boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  const source = { id: 'web-1', kind: 'web' as const, url: 'https://example.com/facts', title: 'Facts', snippet: 'Acme launched a new feature.', domain: 'example.com', publishedAt: null, observedAt: '2026-11-13T12:00:00.000Z', score: 0.9, effectiveAt: null }
  const history = { messages: [], memoryItems: [], researchSnapshots: [] }

  it('maps validated source IDs back to trusted citation metadata', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ statements: [{ text: 'Acme launched a feature.', kind: 'finding', sourceIds: ['web-1'] }] }) }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What launched?', history, sources: [source], claims: [], comparisons: [] })
    expect(answer.citations).toEqual([{ id: 'web-1', title: 'Facts', url: 'https://example.com/facts' }])
    expect(answer.text).toContain('[web-1]')
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.contents[0].parts[0].text).toContain('What launched?')
  })

  it('rejects uncited factual statements and fabricated source IDs', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ statements: [{ text: 'Acme launched it.', kind: 'finding', sourceIds: [] }] }) }] } }] }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ statements: [{ text: 'Acme launched it.', kind: 'finding', sourceIds: ['fake-source'] }] }) }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GeminiHttpProvider()
    const input = { query: 'What launched?', history, sources: [source], claims: [], comparisons: [] }
    await expect(provider.generateAnswer(input)).rejects.toMatchObject({ kind: 'request_failed' })
    await expect(provider.generateAnswer(input)).rejects.toMatchObject({ kind: 'request_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects claims that cite sources outside the supplied evidence set', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: [{ entityName: 'Acme', claimType: 'feature', claimText: 'A new feature.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, effectiveAt: null, confidence: 'high', verification: 'supported', sourceIds: ['fabricated'] }] }) }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new GeminiHttpProvider().extractClaims('What changed?', [source])).rejects.toMatchObject({ kind: 'request_failed' })
  })
})
