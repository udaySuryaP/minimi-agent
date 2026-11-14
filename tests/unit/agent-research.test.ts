import { describe, expect, it, vi } from 'vitest'
import { compareHistoricalAndCurrent } from '@/lib/agent/comparison'
import { executeAgent } from '@/lib/agent/orchestrator'
import { executeSearchPlan, getSearchExecutionLimits, type TavilySearchClient } from '@/lib/agent/search-executor'
import type { EvidenceSource, ExtractedResearchClaim, FinalAnswer, HistoricalRetrieval, SearchPlan, WebSearchResult } from '@/lib/agent/contracts'
import type { HistoricalRepository } from '@/lib/agent/retrieval'
import type { ResearchPersistenceRepository } from '@/lib/agent/persistence'
import type { ResearchReasoner } from '@/lib/agent/providers'

const emptyHistory: HistoricalRetrieval = { messages: [], memoryItems: [], researchSnapshots: [] }
const basePlan: SearchPlan = { shouldSearchWeb: true, currentQuestions: ['query one'], historicalInformationMissing: [], maxCalls: 8, stopReason: 'test' }
const result = (query: string, count = 1): WebSearchResult => ({ query, results: Array.from({ length: count }, (_, i) => ({ title: `Result ${i}`, url: `https://example.com/${query.replaceAll(' ', '-')}/${i}`, snippet: `Evidence ${i}.`, publishedAt: null, score: 0.8 })) })
const answer: FinalAnswer = { text: 'I found a source-backed result. [web-1]', citations: [{ id: 'web-1', title: 'Source', url: 'https://example.com/one' }], claims: [{ text: 'A supported result.', validAt: null, evidence: [{ sourceId: 'web-1', quote: 'Evidence.', url: 'https://example.com/one' }] }] }

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
  const current = (overrides: Partial<ExtractedResearchClaim> = {}): ExtractedResearchClaim => ({ entityName: 'Acme', claimType: 'pricing', claimText: '$20 USD monthly', claimValue: '20', currency: 'USD', billingPeriod: 'monthly', region: 'US', planOrVersion: 'Pro', effectiveAt: null, temporalStatus: 'current', confidence: 'high', verification: 'supported', sourceIds: ['web-1'], ...overrides })
  const history = (overrides: Record<string, unknown> = {}): HistoricalRetrieval => ({
    messages: [], memoryItems: [], researchSnapshots: [{ id: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', query: 'Acme pricing', status: 'completed', createdAt: '2025-01-01T00:00:00.000Z', claims: [{ id: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', snapshotId: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', entityName: 'Acme', claimType: 'pricing', claimText: '$15 USD monthly', claimValue: '15', structuredData: { currency: 'USD', billingPeriod: 'monthly', region: 'US', planOrVersion: 'Pro' }, validAt: null, recordedAt: '2025-01-01T00:00:00.000Z', sources: [] }] }], ...overrides,
  })

  it('detects comparable price changes but refuses mismatched currencies or billing periods', () => {
    expect(compareHistoricalAndCurrent(history(), [current()])[0].outcome).toBe('changed')
    expect(compareHistoricalAndCurrent(history(), [current({ currency: 'EUR' })])[0].outcome).toBe('insufficient_evidence')
    expect(compareHistoricalAndCurrent(history(), [current({ billingPeriod: 'annual' })])[0].outcome).toBe('insufficient_evidence')
  })

  it('reports unchanged, new, unverified, conflicting and insufficient evidence outcomes', () => {
    expect(compareHistoricalAndCurrent(history(), [current({ claimText: '$15 USD monthly', claimValue: '15' })])[0].outcome).toBe('unchanged')
    expect(compareHistoricalAndCurrent(history(), [current({ entityName: 'Beta' })])[0].outcome).toBe('new_information')
    expect(compareHistoricalAndCurrent(history(), [])[0].outcome).toBe('historical_unverified')
    expect(compareHistoricalAndCurrent(history(), [current({ claimText: '$16 USD monthly', claimType: 'feature' })]).some(({ outcome }) => outcome === 'conflicting')).toBe(false)
    expect(compareHistoricalAndCurrent(emptyHistory, [])[0].outcome).toBe('insufficient_evidence')
  })
})

describe('full research orchestration', () => {
  const context = { userId: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', timezone: 'UTC', referenceTimestamp: '2026-11-13T12:00:00.000Z' }
  function dependencies(overrides: Partial<{ history: HistoricalRetrieval }> = {}) {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => overrides.history ?? emptyHistory) }
    const persistence: ResearchPersistenceRepository = { persist: vi.fn(async () => ({ snapshotId: '8d1e4570-f5e5-4e55-a8f7-65791122a2fb', conversationId: '4e63cb00-88fd-4bb5-b271-e6a00e146a2b' })) }
    const reasoner: ResearchReasoner = {
      classifyIntent: vi.fn(),
      extractClaims: vi.fn(async (_query, sources: EvidenceSource[]) => sources.map((source) => ({ entityName: 'Acme', claimType: 'general' as const, claimText: source.snippet, claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, effectiveAt: null, temporalStatus: 'current' as const, confidence: 'medium' as const, verification: 'supported' as const, sourceIds: [source.id] }))),
      generateAnswer: vi.fn(async () => answer),
    }
    const tavily: TavilySearchClient = { search: vi.fn(async (query) => result(query)) }
    return { repository, persistence, reasoner, tavily, deps: { repository, persistence, reasoner, tavily } }
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
    expect(output.status).toBe('completed')
    expect(mock.tavily.search).not.toHaveBeenCalled()
    expect(mock.persistence.persist).not.toHaveBeenCalled()
    expect(mock.reasoner.generateAnswer).toHaveBeenCalledOnce()
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
    expect(output).toMatchObject({ status: 'failed', error: { code: 'PERSISTENCE_ERROR', message: 'Research could not be saved.' } })
    expect(JSON.stringify(output)).not.toContain('private database credentials')
  })
})
