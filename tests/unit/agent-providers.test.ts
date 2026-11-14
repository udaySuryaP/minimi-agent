import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRetryAfter, ProviderRequestError } from '@/lib/agent/provider-errors'

vi.mock('server-only', () => ({}))

import { GeminiHttpProvider, normalizePublishedDate, OpenRouterHttpProvider, TavilyHttpProvider } from '@/lib/agent/providers'
import { buildHistoricalEvidence } from '@/lib/agent/evidence'

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
  const secondSource = { ...source, id: 'web-2', url: 'https://example.com/second', title: 'Second', snippet: 'A second source confirms the feature launch.' }
  const history = { messages: [], memoryItems: [], researchSnapshots: [] }
  const envelope = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] })
  const finding = (text = 'Acme launched a new feature.', sourceIds = ['web-1']) => ({ statements: [{ text, kind: 'finding', sourceIds }] })
  const verification = (status: 'supported' | 'insufficient' | 'conflicting' = 'supported', index = 0) => ({ verifications: [{ index, status }] })
  const savedHistory = (claimText: string, snippet: string | null) => ({ messages: [], memoryItems: [], researchSnapshots: [{
    id: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', query: 'Acme research', status: 'completed' as const, createdAt: '2025-01-01T00:00:00.000Z', claims: [{
      id: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', snapshotId: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', entityName: 'Acme', claimType: 'feature' as const,
      claimText, claimValue: null, structuredData: { verification: 'supported' }, verificationStatus: 'supported' as const, provenance: 'previously_generated_claim' as const,
      validAt: null, recordedAt: '2025-01-01T00:00:00.000Z', sources: snippet === null ? [] : [{ id: '7900b6fb-fb42-4138-9f49-aa304f9482ef', url: 'https://example.com/source', title: 'Original source', snippet, domain: 'example.com', score: 0.9, publishedAt: null, retrievedAt: '2025-01-01T00:00:00.000Z' }],
    }],
  }] })

  it('uses OpenRouter chat completions with required strict structured output when configured', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-only-key')
    vi.stubEnv('OPENROUTER_MODEL', 'test/free-model')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify({ statements: [{ text: 'No supplied source establishes the release date.', kind: 'limitation', sourceIds: [] }] }) } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new OpenRouterHttpProvider().generateAnswer({ query: 'When was it released?', history, sources: [], claims: [], comparisons: [] })
    expect(answer.text).toContain('Insufficient evidence:')
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ authorization: 'Bearer test-only-key' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'test/free-model',
      response_format: { type: 'json_schema', json_schema: { name: 'minimi_answer', strict: true } },
      provider: { require_parameters: true },
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format.json_schema.schema).toMatchObject({ type: 'object', required: ['statements'], additionalProperties: false })
  })

  it('verifies support using only the finding and cited source text, then maps trusted citation metadata', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(finding())).mockResolvedValueOnce(envelope(verification()))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What launched?', history, sources: [source], claims: [], comparisons: [] })
    expect(answer.citations).toEqual([{ id: 'web-1', title: 'Facts', url: 'https://example.com/facts' }])
    expect(answer.text).toContain('[web-1]')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.responseJsonSchema).toMatchObject({ type: 'object', required: ['statements'], additionalProperties: false })
    expect(answer.claims[0].evidence).toEqual([{ sourceId: 'web-1', url: 'https://example.com/facts' }])
    const verifierInput = JSON.parse(fetchMock.mock.calls[1][1].body).contents[0].parts[0].text
    expect(verifierInput).toContain('Acme launched a new feature.')
    expect(verifierInput).toContain(source.snippet)
    expect(verifierInput).not.toContain('What launched?')
    expect(verifierInput).not.toContain('history')
  })

  it('downgrades unsupported and partially supported claims to explicit insufficient evidence', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(finding('Acme acquired Example Corp.', ['web-1']))).mockResolvedValueOnce(envelope(verification('insufficient')))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What happened?', history, sources: [source], claims: [], comparisons: [] })
    expect(answer.text).toContain('Insufficient evidence to verify: Acme acquired Example Corp.')
    expect(answer.claims).toEqual([])
    expect(answer.citations).toEqual([{ id: 'web-1', title: 'Facts', url: source.url }])
  })

  it('rejects unknown source IDs and factual findings with no citations before verification', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(finding('Acme launched it.', ['made-up']))).mockResolvedValueOnce(envelope(finding('Acme launched it.', [])))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GeminiHttpProvider()
    const input = { query: 'What launched?', history, sources: [source], claims: [], comparisons: [] }
    await expect(provider.generateAnswer(input)).rejects.toMatchObject({ kind: 'request_failed' })
    await expect(provider.generateAnswer(input)).rejects.toMatchObject({ kind: 'request_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps attribution from multiple supporting sources', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(finding('Acme launched a feature.', ['web-1', 'web-2']))).mockResolvedValueOnce(envelope(verification()))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What launched?', history, sources: [source, secondSource], claims: [], comparisons: [] })
    expect(answer.citations.map(({ id }) => id)).toEqual(['web-1', 'web-2'])
    expect(answer.claims[0].evidence.map(({ sourceId }) => sourceId)).toEqual(['web-1', 'web-2'])
  })

  it('labels model limitations as insufficient rather than presenting them as verified facts', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const fetchMock = vi.fn().mockResolvedValue(envelope({ statements: [{ text: 'The supplied records do not establish the release date.', kind: 'limitation', sourceIds: [] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'When was it released?', history, sources: [], claims: [], comparisons: [] })
    expect(answer.text).toBe('Insufficient evidence: The supplied records do not establish the release date.')
    expect(answer.claims).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('renders verifier conflicts and fails closed for malformed or failed verifier responses', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const conflictFetch = vi.fn().mockResolvedValueOnce(envelope(finding())).mockResolvedValueOnce(envelope(verification('conflicting')))
    vi.stubGlobal('fetch', conflictFetch)
    const input = { query: 'What launched?', history, sources: [source], claims: [], comparisons: [] }
    const answer = await new GeminiHttpProvider().generateAnswer(input)
    expect(answer.text).toContain('Conflicting evidence:')
    expect(answer.claims).toEqual([])

    const malformedFetch = vi.fn().mockResolvedValueOnce(envelope(finding())).mockResolvedValueOnce(envelope({ verifications: [{ index: 0, status: 'supported', quote: 'Fabricated quote.' }] }))
    vi.stubGlobal('fetch', malformedFetch)
    await expect(new GeminiHttpProvider().generateAnswer(input)).rejects.toMatchObject({ kind: 'request_failed' })

    const failureFetch = vi.fn().mockResolvedValueOnce(envelope(finding())).mockResolvedValueOnce(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', failureFetch)
    await expect(new GeminiHttpProvider().generateAnswer(input)).rejects.toMatchObject({ kind: 'request_failed' })
  })

  it('preserves temporal statuses, keeps old publications from being labeled current, and separates effective time', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const oldSource = { ...source, publishedAt: { precision: 'date' as const, value: '2020-01-01' } }
    const outputClaims = { claims: [
      { entityName: 'Acme', claimType: 'feature', proposition: 'offline mode', claimText: 'Feature was launched in 2020.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown', discountConditions: null, effectiveAt: null, temporalStatus: 'current', confidence: 'high', verification: 'supported', sourceIds: ['web-1'] },
      { entityName: 'Acme', claimType: 'announcement', proposition: 'feature update', claimText: 'Feature update announced.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown', discountConditions: null, effectiveAt: { precision: 'date', value: '2020-02-01' }, temporalStatus: 'historical', confidence: 'high', verification: 'supported', sourceIds: ['web-1'] },
      { entityName: 'Acme', claimType: 'general', proposition: null, claimText: 'Validity cannot be determined.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown', discountConditions: null, effectiveAt: null, temporalStatus: 'unknown', confidence: 'low', verification: 'uncertain', sourceIds: ['web-1'] },
    ] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(envelope(outputClaims)).mockResolvedValueOnce(envelope({ verifications: [0, 1, 2].map((index) => ({ index, status: 'supported' })) })))
    const claims = await new GeminiHttpProvider().extractClaims('What changed?', [oldSource])
    expect(claims.map(({ temporalStatus }) => temporalStatus)).toEqual(['unknown', 'historical', 'unknown'])
    expect(claims[1].effectiveAt).toEqual({ precision: 'date', value: '2020-02-01' })
    expect(claims[0].effectiveAt).toBeNull()
  })

  it('preserves recent-source temporal uncertainty rather than inferring current validity', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const recentSource = { ...source, publishedAt: { precision: 'date' as const, value: '2026-11-13' } }
    const baseClaim = { entityName: 'Acme', claimType: 'feature', proposition: 'offline mode', claimText: 'Acme currently supports offline mode.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown', discountConditions: null, effectiveAt: null, confidence: 'medium', verification: 'uncertain', sourceIds: ['web-1'] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(envelope({ claims: [
      { ...baseClaim, temporalStatus: 'current' },
      { ...baseClaim, proposition: 'sync mode', claimText: 'Acme currently supports sync mode.', temporalStatus: 'current' },
      { ...baseClaim, temporalStatus: 'historical' },
      { ...baseClaim, proposition: 'pricing availability', claimType: 'pricing', temporalStatus: 'unknown' },
    ] })).mockResolvedValueOnce(envelope({ verifications: [0, 1, 2, 3].map((index) => ({ index, status: 'supported' })) })))
    const claims = await new GeminiHttpProvider().extractClaims('Does Acme currently support offline mode?', [recentSource])
    expect(claims.map(({ temporalStatus }) => temporalStatus)).toEqual(['unknown', 'current', 'unknown', 'unknown'])
    expect(claims[0].effectiveAt).toBeNull()
  })

  it('omits extracted claims that fail support review and fails closed when the claim verifier fails', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const claim = { entityName: 'Acme', claimType: 'feature', proposition: 'offline mode', claimText: 'Acme acquired another company.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown', discountConditions: null, effectiveAt: null, temporalStatus: 'unknown', confidence: 'high', verification: 'supported', sourceIds: ['web-1'] }
    const unsupportedFetch = vi.fn().mockResolvedValueOnce(envelope({ claims: [claim] })).mockResolvedValueOnce(envelope({ verifications: [{ index: 0, status: 'insufficient' }] }))
    vi.stubGlobal('fetch', unsupportedFetch)
    expect(await new GeminiHttpProvider().extractClaims('What changed?', [source])).toEqual([])

    const failedFetch = vi.fn().mockResolvedValueOnce(envelope({ claims: [claim] })).mockResolvedValueOnce(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', failedFetch)
    await expect(new GeminiHttpProvider().extractClaims('What changed?', [source])).rejects.toMatchObject({ kind: 'request_failed' })
  })

  it('does not let an empty persisted source snippet verify the saved claim that cites it', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const claimText = 'Acme launched feature X.'
    const history = savedHistory(claimText, '')
    const sources = buildHistoricalEvidence(history)
    const fetchMock = vi.fn().mockResolvedValue(envelope(finding(claimText, ['history-source:7900b6fb-fb42-4138-9f49-aa304f9482ef'])))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What did Acme launch?', history, sources, claims: [], comparisons: [] })
    expect(answer.text).toContain('Insufficient evidence to verify:')
    expect(answer.claims).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('checks the original unrelated source content rather than the saved claim text', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const claimText = 'Acme increased prices.'
    const originalSnippet = 'The source discusses office locations and hiring plans. '.repeat(20)
    const history = savedHistory(claimText, originalSnippet)
    const sources = buildHistoricalEvidence(history)
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(finding(claimText, ['history-source:7900b6fb-fb42-4138-9f49-aa304f9482ef']))).mockResolvedValueOnce(envelope(verification('insufficient')))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'Did prices increase?', history, sources, claims: [], comparisons: [] })
    const parsedVerifierInput = JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).contents[0].parts[0].text)
    expect(parsedVerifierInput[0].claim).toBe(claimText)
    expect(parsedVerifierInput[0].sources[0].content).toBe(originalSnippet)
    expect(parsedVerifierInput[0].sources[0].content).not.toContain(claimText)
    expect(answer.text).toContain('Insufficient evidence to verify:')
  })

  it('can verify a finding against genuinely supporting original source content', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const history = savedHistory('Acme launched feature X.', 'Acme announced the launch of feature X in January.')
    const sources = buildHistoricalEvidence(history)
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(finding('Acme launched feature X.', ['history-source:7900b6fb-fb42-4138-9f49-aa304f9482ef']))).mockResolvedValueOnce(envelope(verification('supported')))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What did Acme launch?', history, sources, claims: [], comparisons: [] })
    expect(answer.text).toContain('Acme launched feature X.')
    expect(answer.claims).toHaveLength(1)
  })

  it('keeps generated historical claims as separate contextual provenance when source metadata is missing', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    const claimText = 'Acme launched feature X.'
    const history = savedHistory(claimText, null)
    const sources = buildHistoricalEvidence(history)
    expect(sources).toEqual([])
    const fetchMock = vi.fn().mockResolvedValue(envelope({ statements: [{ text: 'The saved historical record says Acme launched feature X, but no original source is available.', kind: 'limitation', sourceIds: [] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const answer = await new GeminiHttpProvider().generateAnswer({ query: 'What did Acme launch?', history, sources, claims: [], comparisons: [] })
    const parsedGenerationInput = JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts[0].text)
    expect(parsedGenerationInput.history.researchSnapshots[0].claims[0]).toMatchObject({ claimText, provenance: 'previously_generated_claim', verificationStatus: 'supported' })
    expect(parsedGenerationInput.sources).toEqual([])
    expect(answer.text).toContain('Insufficient evidence:')
  })
})

describe('OpenRouter claim extraction normalization and bounded recovery', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  const source = { id: 'web-1', kind: 'web' as const, url: 'https://example.com/facts', title: 'Facts', snippet: 'Acme launched offline mode on 2025-03-01.', domain: 'example.com', publishedAt: null, observedAt: '2026-11-13T12:00:00.000Z', score: 0.9, effectiveAt: null }
  const claim = (overrides: Record<string, unknown> = {}) => ({ entityName: 'Acme', claimType: 'announcement', proposition: 'offline mode launch', claimText: 'Acme launched offline mode on 2025-03-01.', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown', discountConditions: null, effectiveAt: { precision: 'date', value: '2025-03-01' }, temporalStatus: 'historical', confidence: 'high', verification: 'supported', sourceIds: ['web-1'], ...overrides })
  const completion = (content: unknown) => Response.json({ choices: [{ message: { content } }] })
  const verified = () => completion(JSON.stringify({ verifications: [{ index: 0, status: 'supported' }] }))
  function configure() { vi.stubEnv('OPENROUTER_API_KEY', 'test-only-key'); vi.stubEnv('OPENROUTER_MODEL', 'test/primary'); vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'test/fallback') }

  it('accepts a valid primary response and a single direct claim object without trusting model verification', async () => {
    configure()
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(JSON.stringify(claim()))).mockResolvedValueOnce(verified())
    vi.stubGlobal('fetch', fetchMock)
    const claims = await new OpenRouterHttpProvider().extractClaims('What launched?', [source])
    expect(claims).toHaveLength(1)
    expect(claims[0].verification).toBe('supported')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepts the provider envelope with JSON text content blocks', async () => {
    configure()
    const json = JSON.stringify({ claims: [claim()] })
    const fetchMock = vi.fn().mockResolvedValueOnce(completion([{ type: 'text', text: json.slice(0, 40) }, { type: 'text', text: json.slice(40) }])).mockResolvedValueOnce(verified())
    vi.stubGlobal('fetch', fetchMock)
    expect(await new OpenRouterHttpProvider().extractClaims('What launched?', [source])).toHaveLength(1)
  })

  it.each([
    ['claimType', { claimType: 'product_update' }], ['claimValue', { claimValue: { amount: 10 } }], ['verification', { verification: 'verified' }],
    ['wrong top-level structure', { result: { claims: [claim()] } }], ['missing required fields', { claims: [{ entityName: 'Acme' }] }],
    ['unexpected extra fields', { claims: [claim({ hidden: true })] }], ['empty output', ''],
  ])('repairs once then uses fallback for %s mismatch', async (_label, invalid) => {
    configure()
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(JSON.stringify(invalid))).mockResolvedValueOnce(completion(JSON.stringify({ claims: [claim()] }))).mockResolvedValueOnce(verified())
    vi.stubGlobal('fetch', fetchMock)
    expect(await new OpenRouterHttpProvider().extractClaims('What launched?', [source])).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('test/primary')
  })

  it('allows the configured fallback after the primary repair fails schema validation', async () => {
    configure()
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(JSON.stringify({ claims: [claim({ confidence: 'supported' })] }))).mockResolvedValueOnce(completion(JSON.stringify({ claims: [claim({ temporalStatus: null })] }))).mockResolvedValueOnce(completion(JSON.stringify({ claims: [claim()] }))).mockResolvedValueOnce(verified())
    vi.stubGlobal('fetch', fetchMock)
    expect(await new OpenRouterHttpProvider().extractClaims('What launched?', [source])).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).model).toBe('test/fallback')
  })

  it('fails in a bounded way when repair and fallback both fail', async () => {
    configure()
    const fetchMock = vi.fn().mockResolvedValueOnce(completion('{broken')).mockResolvedValueOnce(completion('{still broken')).mockResolvedValueOnce(completion(JSON.stringify({ claims: [{ entityName: 'Acme' }] })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new OpenRouterHttpProvider().extractClaims('What launched?', [source])).rejects.toMatchObject({ kind: 'request_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('times out, repairs once, then uses the fallback with finite calls', async () => {
    configure()
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException('private', 'TimeoutError')).mockResolvedValueOnce(completion('{bad')).mockResolvedValueOnce(completion(JSON.stringify({ claims: [claim()] }))).mockResolvedValueOnce(verified())
    vi.stubGlobal('fetch', fetchMock)
    expect(await new OpenRouterHttpProvider().extractClaims('What launched?', [source])).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('omits unsupported evidence even when its claim JSON is valid', async () => {
    configure()
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(JSON.stringify({ claims: [claim()] }))).mockResolvedValueOnce(completion(JSON.stringify({ verifications: [{ index: 0, status: 'insufficient' }] })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await new OpenRouterHttpProvider().extractClaims('What launched?', [source])).toEqual([])
  })
})
