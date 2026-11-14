import { describe, expect, it, vi } from 'vitest'
import { compareHistoricalAndCurrent } from '@/lib/agent/comparison'
import { executeAgent, type AgentDependencies } from '@/lib/agent/orchestrator'
import { executeSearchPlan, getSearchExecutionLimits, type TavilySearchClient } from '@/lib/agent/search-executor'
import type { EvidenceSource, ExtractedResearchClaim, FinalAnswer, HistoricalRetrieval, SearchPlan, WebSearchResult } from '@/lib/agent/contracts'
import type { HistoricalRepository } from '@/lib/agent/retrieval'
import type { ResearchPersistenceRepository } from '@/lib/agent/persistence'
import type { ResearchReasoner } from '@/lib/agent/providers'

const emptyHistory: HistoricalRetrieval = { messages: [], memoryItems: [], researchSnapshots: [] }
const basePlan: SearchPlan = { shouldSearchWeb: true, currentQuestions: ['query one'], historicalInformationMissing: [], maxCalls: 8, stopReason: 'test' }
const result = (query: string, count = 1): WebSearchResult => ({ query, results: Array.from({ length: count }, (_, i) => ({ title: `Result ${i}`, url: `https://example.com/${query.replaceAll(' ', '-')}/${i}`, snippet: `Evidence ${i}.`, publishedAt: null, score: 0.8 })) })
const answer: FinalAnswer = { text: 'I found a source-backed result. [web-1]', citations: [{ id: 'web-1', title: 'Source', url: 'https://example.com/one' }], claims: [{ text: 'A supported result.', validAt: null, evidence: [{ sourceId: 'web-1', url: 'https://example.com/one' }] }] }

describe('bounded search executor', () => {
  it('enforces eight calls and five results per call and accounts for all attempts', async () => {
    const provider: TavilySearchClient = { search: vi.fn(async (query) => result(query, 7)) }
    const plan = { ...basePlan, currentQuestions: Array.from({ length: 12 }, (_, index) => `query ${index}`) }
    const { execution, results } = await executeSearchPlan(plan, provider)
    expect(provider.search).toHaveBeenCalledTimes(8)
    expect(provider.search).toHaveBeenNthCalledWith(1, 'query 0', expect.objectContaining({ maxResults: 5, signal: expect.any(AbortSignal) }))
    expect(execution).toMatchObject({ attemptedCalls: 8, completedCalls: 8, budgetExhausted: true, outcomes: expect.arrayContaining([{ query: 'query 0', status: 'succeeded', resultCount: 5, failure: null }]) })
    expect(results.every((item) => item.results.length === 5)).toBe(true)
  })

  it('enforces per-call timeouts, records failures, and does not retry', async () => {
    const provider: TavilySearchClient = { search: vi.fn(async (_query, { signal }) => await new Promise<WebSearchResult>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')), { once: true }))) }
    const execution = await executeSearchPlan({ ...basePlan, currentQuestions: ['slow'] }, provider, { maxCalls: 8, maxResultsPerCall: 5, perCallTimeoutMs: 15, totalTimeoutMs: 100 })
    expect(provider.search).toHaveBeenCalledOnce()
    expect(execution.execution).toMatchObject({ attemptedCalls: 1, completedCalls: 1, outcomes: [{ status: 'failed', failure: { kind: 'timeout' } }] })
  })

  it('stops starting calls when the total execution budget is consumed', async () => {
    let elapsed = 0
    const provider: TavilySearchClient = { search: vi.fn(async (query) => { elapsed += 120; return result(query) }) }
    const plan = { ...basePlan, currentQuestions: ['first', 'second', 'third'] }
    const execution = await executeSearchPlan(plan, provider, { maxCalls: 8, maxResultsPerCall: 5, perCallTimeoutMs: 8_000, totalTimeoutMs: 200 }, () => elapsed)
    expect(provider.search).toHaveBeenCalledTimes(2)
    expect(execution.execution.budgetExhausted).toBe(true)
  })

  it('continues after a bounded provider failure when budget remains', async () => {
    const provider: TavilySearchClient = { search: vi.fn().mockRejectedValueOnce(new Error('private key detail')).mockImplementationOnce(async (query) => result(query)) }
    const plan = { ...basePlan, currentQuestions: ['first', 'second'] }
    const { execution, results } = await executeSearchPlan(plan, provider)
    expect(provider.search).toHaveBeenCalledTimes(2)
    expect(execution.outcomes.map(({ status }) => status)).toEqual(['failed', 'succeeded'])
    expect(JSON.stringify(execution)).not.toContain('private key detail')
    expect(results).toHaveLength(1)
  })

  it('validates plans, supports no-search plans, and keeps environment limits below hard caps', async () => {
    const provider: TavilySearchClient = { search: vi.fn(async (query) => result(query)) }
    const noSearch = await executeSearchPlan({ ...basePlan, shouldSearchWeb: false }, provider)
    expect(noSearch.execution.attemptedCalls).toBe(0)
    expect(provider.search).not.toHaveBeenCalled()
    expect(getSearchExecutionLimits({ AGENT_MAX_SEARCH_CALLS: '500', AGENT_MAX_RESULTS_PER_CALL: '99', AGENT_SEARCH_CALL_TIMEOUT_MS: '90000', AGENT_SEARCH_TOTAL_TIMEOUT_MS: '90000' })).toEqual({ maxCalls: 8, maxResultsPerCall: 5, perCallTimeoutMs: 8000, totalTimeoutMs: 30000 })
    await expect(executeSearchPlan({ ...basePlan, maxCalls: 9 } as SearchPlan, provider)).rejects.toThrow()
  })
})

describe('historical and current comparison', () => {
  const current = (overrides: Partial<ExtractedResearchClaim> = {}): ExtractedResearchClaim => ({ entityName: 'Acme', claimType: 'pricing', proposition: 'Acme Pro subscription', claimText: '$20 USD monthly', claimValue: '20', currency: 'USD', billingPeriod: 'monthly', region: 'US', planOrVersion: 'Pro', priceType: 'standard', discountConditions: null, effectiveAt: null, temporalStatus: 'current', confidence: 'high', verification: 'supported', sourceIds: ['web-1'], ...overrides })
  const history = (claimOverrides: Record<string, unknown> = {}, claimType: 'pricing' | 'feature' = 'pricing', proposition = 'Acme Pro subscription'): HistoricalRetrieval => ({
    messages: [], memoryItems: [], researchSnapshots: [{ id: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', query: 'Acme pricing', status: 'completed', createdAt: '2025-01-01T00:00:00.000Z', claims: [{ id: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', snapshotId: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', entityName: 'Acme', claimType, claimText: claimType === 'pricing' ? '$15 USD monthly' : 'Acme supports offline mode', claimValue: claimType === 'pricing' ? '15' : null, structuredData: { proposition, currency: 'USD', billingPeriod: 'monthly', region: 'US', planOrVersion: 'Pro', priceType: 'standard', discountConditions: null, ...claimOverrides }, verificationStatus: 'supported', provenance: 'previously_generated_claim', validAt: null, recordedAt: '2025-01-01T00:00:00.000Z', sources: [] }] }],
  })

  it('compares price increases, decreases, and unchanged values only for equivalent dimensions', () => {
    expect(compareHistoricalAndCurrent(history(), [current()])[0].outcome).toBe('changed')
    expect(compareHistoricalAndCurrent(history(), [current({ claimValue: '10', claimText: '$10 USD monthly' })])[0].outcome).toBe('changed')
    expect(compareHistoricalAndCurrent(history(), [current({ claimValue: '15', claimText: '$15 USD monthly' })])[0].outcome).toBe('unchanged')
  })

  it('returns insufficient evidence for promotional, plan, currency, billing, region, or missing dimensions', () => {
    const cases = [
      current({ priceType: 'promotional', discountConditions: 'new customers only' }),
      current({ planOrVersion: 'Basic' }), current({ currency: 'EUR' }), current({ billingPeriod: 'annual' }), current({ region: 'EU' }),
      current({ currency: null }), current({ proposition: null }),
    ]
    for (const item of cases) expect(compareHistoricalAndCurrent(history(), [item])[0].outcome).toBe('insufficient_evidence')
  })

  it.each([
    ['unknown historical and unknown current price types', 'unknown', 'unknown', 'insufficient_evidence', '20'],
    ['unknown historical and standard current price types', 'unknown', 'standard', 'insufficient_evidence', '20'],
    ['standard historical and unknown current price types', 'standard', 'unknown', 'insufficient_evidence', '20'],
    ['missing historical price type', undefined, 'standard', 'insufficient_evidence', '20'],
    ['missing current price type', 'standard', undefined, 'insufficient_evidence', '20'],
    ['unsupported historical price type', 'legacy', 'standard', 'insufficient_evidence', '20'],
    ['unsupported current price type', 'standard', 'legacy', 'insufficient_evidence', '20'],
    ['matching standard types and amounts', 'standard', 'standard', 'unchanged', '15'],
    ['matching standard types with changed amounts', 'standard', 'standard', 'changed', '20'],
    ['incompatible standard and promotional types', 'standard', 'promotional', 'insufficient_evidence', '20'],
  ])('%s', (_name, historicalPriceType, currentPriceType, expected, currentAmount) => {
    const old = history()
    const structuredData = old.researchSnapshots[0].claims[0].structuredData
    if (historicalPriceType === undefined) delete structuredData.priceType
    else structuredData.priceType = historicalPriceType
    old.researchSnapshots[0].claims[0].claimValue = '15'

    const currentClaim = current({ priceType: (currentPriceType ?? 'standard') as ExtractedResearchClaim['priceType'], claimValue: currentAmount ?? '20' })
    if (currentPriceType === undefined) Reflect.deleteProperty(currentClaim, 'priceType')
    else if (currentPriceType === 'legacy') Reflect.set(currentClaim, 'priceType', currentPriceType)

    expect(compareHistoricalAndCurrent(old, [currentClaim])[0].outcome).toBe(expected)
  })

  it('does not conflict two unrelated features but detects differing claims about the same feature', () => {
    const old = history({}, 'feature', 'offline mode')
    const unrelated = current({ claimType: 'feature', proposition: 'single sign-on', claimText: 'Acme supports SSO', claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: 'Pro', priceType: 'unknown' })
    expect(compareHistoricalAndCurrent(old, [unrelated]).map(({ outcome }) => outcome)).toContain('new_information')
    expect(compareHistoricalAndCurrent(old, [unrelated]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
    const differentDescription = { ...unrelated, proposition: 'offline mode', claimText: 'Offline mode is limited to Pro accounts.' }
    expect(compareHistoricalAndCurrent(old, [differentDescription]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
    old.researchSnapshots[0].claims[0].claimValue = 'supported'
    const contradiction = { ...differentDescription, claimText: 'Acme does not support offline mode.', claimValue: 'unsupported' }
    expect(compareHistoricalAndCurrent(old, [contradiction]).some(({ outcome }) => outcome === 'conflicting')).toBe(true)
  })

  it('prioritizes explicit opposite feature values over identical text', () => {
    const old = history({}, 'feature', 'Acme SSO support')
    const historicalClaim = old.researchSnapshots[0].claims[0]
    historicalClaim.claimText = 'Acme SSO is supported.'
    const currentFeature = (claimValue: string | null, overrides: Partial<ExtractedResearchClaim> = {}) => current({
      claimType: 'feature', proposition: 'Acme SSO support', claimText: 'Acme SSO is supported.', claimValue,
      currency: null, billingPeriod: null, region: null, priceType: 'unknown', discountConditions: null, ...overrides,
    })

    for (const [before, after] of [
      ['supported', 'unsupported'], ['unsupported', 'supported'], ['true', 'false'], ['yes', 'no'],
      ['available', 'unavailable'], ['enabled', 'disabled'],
    ]) {
      historicalClaim.claimValue = before
      expect(compareHistoricalAndCurrent(old, [currentFeature(after)])[0].outcome).toBe('conflicting')
    }

    historicalClaim.claimValue = 'supported'
    expect(compareHistoricalAndCurrent(old, [currentFeature('supported')])[0].outcome).toBe('unchanged')
    expect(compareHistoricalAndCurrent(old, [currentFeature('unsupported', { claimText: 'Acme SSO is not supported.' })])[0].outcome).toBe('conflicting')
    expect(compareHistoricalAndCurrent(old, [currentFeature(null)])[0].outcome).toBe('unchanged')

    const unknownHistory = history({}, 'feature', 'Acme SSO support')
    unknownHistory.researchSnapshots[0].claims[0].claimText = historicalClaim.claimText
    unknownHistory.researchSnapshots[0].claims[0].claimValue = 'supported'
    unknownHistory.researchSnapshots[0].claims[0].verificationStatus = 'unknown'
    expect(compareHistoricalAndCurrent(unknownHistory, [currentFeature('unsupported')])[0].outcome).toBe('insufficient_evidence')

    expect(compareHistoricalAndCurrent(old, [currentFeature('unsupported', { entityName: 'Beta' })]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
    expect(compareHistoricalAndCurrent(old, [currentFeature('unsupported', { proposition: 'different feature' })]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
  })

  it('detects contradicting current sources only for the same proposition and price dimensions', () => {
    const first = current({ claimText: 'Costs 20 USD monthly', claimValue: '20' })
    const second = current({ claimText: 'Costs 25 USD monthly', claimValue: '25', sourceIds: ['web-2'] })
    expect(compareHistoricalAndCurrent(emptyHistory, [first, second]).some(({ outcome }) => outcome === 'conflicting')).toBe(true)
    expect(compareHistoricalAndCurrent(emptyHistory, [])[0].outcome).toBe('insufficient_evidence')
  })

  it('detects current feature contradictions even when normalized claim text is identical', () => {
    const first = current({ claimType: 'feature', proposition: 'Acme SSO support', claimText: 'Acme SSO is supported.', claimValue: 'supported', currency: null, billingPeriod: null, region: null, priceType: 'unknown', discountConditions: null })
    const second = { ...first, claimValue: 'unsupported', sourceIds: ['web-2'] }
    expect(compareHistoricalAndCurrent(emptyHistory, [first, second]).some(({ outcome }) => outcome === 'conflicting')).toBe(true)
    expect(compareHistoricalAndCurrent(emptyHistory, [first, { ...first, claimValue: null, sourceIds: ['web-2'] }]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
    expect(compareHistoricalAndCurrent(emptyHistory, [first, { ...second, entityName: 'Beta' }]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
    expect(compareHistoricalAndCurrent(emptyHistory, [first, { ...second, proposition: 'Different feature' }]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
  })

  it('uses the explicit no-longer-verifiable and new-information outcomes conservatively', () => {
    expect(compareHistoricalAndCurrent(history(), [])[0].outcome).toBe('no_longer_verifiable')
    expect(compareHistoricalAndCurrent(history(), [current({ entityName: 'Beta' })])[0].outcome).toBe('new_information')
  })

  it('allows only supported historical claims to drive definitive comparisons', () => {
    expect(compareHistoricalAndCurrent(history(), [current()])[0].outcome).toBe('changed')
    const cases = [
      { status: 'uncertain', outcome: 'changed' },
      { status: 'unsupported', outcome: 'unchanged' },
      { status: 'insufficient_evidence', outcome: 'conflicting' },
      { status: 'unknown', outcome: 'changed' },
    ] as const
    for (const { status, outcome } of cases) {
      const old = history()
      old.researchSnapshots[0].claims[0].verificationStatus = status
      const results = compareHistoricalAndCurrent(old, [current()])
      expect(results.some((item) => item.outcome === outcome)).toBe(false)
      expect(results.some((item) => item.outcome === 'insufficient_evidence')).toBe(true)
    }
  })

  it('uses supported historical claims when supported and uncertain records are mixed', () => {
    const old = history()
    old.researchSnapshots[0].claims.push({ ...old.researchSnapshots[0].claims[0], id: 'b879e41c-5110-485f-a9be-7cd85a2b8ad8', verificationStatus: 'uncertain', claimText: '$99 USD monthly', claimValue: '99' })
    const outcomes = compareHistoricalAndCurrent(old, [current()]).map(({ outcome }) => outcome)
    expect(outcomes).toContain('changed')
    expect(outcomes).toContain('insufficient_evidence')
    expect(outcomes).not.toContain('conflicting')
  })

  it('keeps current claim verification requirements enforced', () => {
    const result = compareHistoricalAndCurrent(history(), [current({ verification: 'uncertain' })])
    expect(result[0].outcome).toBe('insufficient_evidence')
  })
})

describe('full research orchestration', () => {
  const context = { userId: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', timezone: 'UTC', referenceTimestamp: '2026-11-13T12:00:00.000Z' }
  function dependencies(overrides: Partial<{ history: HistoricalRetrieval }> = {}) {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => overrides.history ?? emptyHistory) }
    const persistence: ResearchPersistenceRepository = { persist: vi.fn(async () => ({ snapshotId: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', conversationId: '4e63cb00-88fd-4bb5-b271-e6a00e146a2b' })) }
    const reasoner: ResearchReasoner = {
      classifyIntent: vi.fn(),
      extractClaims: vi.fn(async (_query, sources: EvidenceSource[]) => sources.map((source) => ({ entityName: 'Acme', claimType: 'general' as const, proposition: null, claimText: source.snippet, claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown' as const, discountConditions: null, effectiveAt: null, temporalStatus: 'unknown' as const, confidence: 'medium' as const, verification: 'supported' as const, sourceIds: [source.id] }))),
      generateAnswer: vi.fn(async () => answer),
    }
    const tavily: TavilySearchClient = { search: vi.fn(async (query) => result(query)) }
    const deps: AgentDependencies = { repository, persistence, reasoner, tavily }
    return { repository, persistence, reasoner, tavily, deps }
  }

  it('executes search, grounds the answer, and persists a new snapshot', async () => {
    const mock = dependencies()
    const output = await executeAgent({ query: 'What is the latest Acme news?' }, context, mock.deps)
    expect(output.status).toBe('completed')
    expect(mock.tavily.search).toHaveBeenCalledOnce()
    expect(mock.reasoner.extractClaims).toHaveBeenCalledOnce()
    expect(mock.reasoner.generateAnswer).toHaveBeenCalledOnce()
    expect(mock.persistence.persist).toHaveBeenCalledOnce()
    expect(output.snapshotId).toBe('8d1e4570-f5e5-4e55-a8f7-65791122a2fb')
  })

  it('does not search or persist for a non-current-research query', async () => {
    const mock = dependencies()
    const output = await executeAgent({ query: 'hello there' }, context, mock.deps)
    expect(output.status).toBe('no_search')
    expect(mock.tavily.search).not.toHaveBeenCalled()
    expect(mock.persistence.persist).not.toHaveBeenCalled()
    expect(mock.reasoner.generateAnswer).toHaveBeenCalledOnce()
  })

  it('reports all planned search failures as failed and does not fabricate an answer', async () => {
    const mock = dependencies()
    mock.deps.planSearch = () => ({ ...basePlan, currentQuestions: ['first', 'second'] })
    vi.mocked(mock.tavily.search).mockRejectedValue(new Error('provider secret'))
    const output = await executeAgent({ query: 'latest Acme news' }, context, mock.deps)
    expect(output).toMatchObject({ status: 'failed', answer: null, searchExecution: { attemptedCalls: 2, outcomes: [{ status: 'failed' }, { status: 'failed' }] }, error: { code: 'PROVIDER_ERROR' } })
    expect(mock.reasoner.generateAnswer).not.toHaveBeenCalled()
    expect(mock.persistence.persist).toHaveBeenCalledOnce()
  })

  it('reports mixed search success and failure as partial with usable evidence', async () => {
    const mock = dependencies()
    mock.deps.planSearch = () => ({ ...basePlan, currentQuestions: ['first', 'second'] })
    vi.mocked(mock.tavily.search).mockRejectedValueOnce(new Error('provider secret')).mockImplementationOnce(async (query) => result(query))
    const output = await executeAgent({ query: 'latest Acme news' }, context, mock.deps)
    expect(output).toMatchObject({ status: 'partial', answer: expect.any(Object), searchExecution: { outcomes: [{ status: 'failed' }, { status: 'succeeded' }] }, error: { code: 'PROVIDER_ERROR' } })
    expect(output.evidenceSources.some(({ kind }) => kind === 'web')).toBe(true)
    expect(mock.persistence.persist).toHaveBeenCalledOnce()
  })

  it('distinguishes successful empty search results from provider failure', async () => {
    const mock = dependencies()
    vi.mocked(mock.tavily.search).mockResolvedValue({ query: 'latest Acme news', results: [] })
    const output = await executeAgent({ query: 'latest Acme news' }, context, mock.deps)
    expect(output).toMatchObject({ status: 'completed', searchExecution: { outcomes: [{ status: 'succeeded', resultCount: 0, failure: null }] } })
  })

  it('returns and persists a partial result when answer generation fails', async () => {
    const mock = dependencies()
    vi.mocked(mock.reasoner.generateAnswer).mockRejectedValue(new Error('Gemini private detail'))
    const output = await executeAgent({ query: 'latest Acme news' }, context, mock.deps)
    expect(output).toMatchObject({ status: 'partial', answer: null, error: { code: 'PROVIDER_ERROR' } })
    expect(JSON.stringify(output)).not.toContain('private detail')
    expect(mock.persistence.persist).toHaveBeenCalledOnce()
  })

  it('does not call retrieval or providers when temporal clarification is required', async () => {
    const mock = dependencies()
    const output = await executeAgent({ query: 'What happened Wednesday?' }, { ...context, referenceTimestamp: '2026-11-11T12:00:00.000Z' }, mock.deps)
    expect(output.status).toBe('needs_clarification')
    expect(mock.repository.retrieve).not.toHaveBeenCalled()
    expect(mock.tavily.search).not.toHaveBeenCalled()
    expect(mock.reasoner.classifyIntent).not.toHaveBeenCalled()
  })

  it('does not report success when snapshot persistence fails', async () => {
    const mock = dependencies()
    vi.mocked(mock.persistence.persist).mockRejectedValue(new Error('private database credentials'))
    const output = await executeAgent({ query: 'latest Acme news' }, context, mock.deps)
    expect(output).toMatchObject({ status: 'partial', answer: expect.any(Object), error: { code: 'PERSISTENCE_ERROR', message: 'Research results were generated but could not be saved.' } })
    expect(JSON.stringify(output)).not.toContain('private database credentials')
  })
})
