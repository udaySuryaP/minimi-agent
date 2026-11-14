import { describe, expect, it, vi } from 'vitest'
import { AgentQuerySchema, IntentResultSchema } from '@/lib/agent/contracts'
import { classifyIntent, classifyIntentDeterministically } from '@/lib/agent/intent'
import { executeAgent } from '@/lib/agent/orchestrator'
import { createSearchPlan } from '@/lib/agent/search-plan'
import { createTemporalRetrievalFilter, localDateStartUtc, resolveTemporalReferences } from '@/lib/agent/temporal'
import { buildHistoricalSearchQuery, HISTORICAL_CANDIDATE_LIMIT, rankHistoricalRows, SupabaseHistoricalRepository, type HistoricalRepository } from '@/lib/agent/retrieval'
import { ProviderRequestError } from '@/lib/agent/provider-errors'
import type { Database } from '@/lib/supabase/types'
import type { SupabaseClient } from '@supabase/supabase-js'

const context = { userId: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', timezone: 'Asia/Kolkata' }
const emptyHistory = { messages: [], memoryItems: [], researchSnapshots: [] }

type QueryCall = { table: string; method: string; args: unknown[] }
function makeQueryMock(rows: Record<string, unknown[]> = {}) {
  const calls: QueryCall[] = []
  const client = {
    from(table: string) {
      let selectedRange: [number, number] | null = null
      const query = {
        select(...args: unknown[]) { calls.push({ table, method: 'select', args }); return query },
        eq(...args: unknown[]) { calls.push({ table, method: 'eq', args }); return query },
        gte(...args: unknown[]) { calls.push({ table, method: 'gte', args }); return query },
        lt(...args: unknown[]) { calls.push({ table, method: 'lt', args }); return query },
        or(...args: unknown[]) { calls.push({ table, method: 'or', args }); return query },
        textSearch(...args: unknown[]) { calls.push({ table, method: 'textSearch', args }); return query },
        order(...args: unknown[]) { calls.push({ table, method: 'order', args }); return query },
        range(from: number, to: number) { calls.push({ table, method: 'range', args: [from, to] }); selectedRange = [from, to]; return query },
        limit(...args: unknown[]) { calls.push({ table, method: 'limit', args }); return query },
        in(...args: unknown[]) { calls.push({ table, method: 'in', args }); return query },
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          const data = rows[table] ?? []
          const selected = selectedRange ? data.slice(selectedRange[0], selectedRange[1] + 1) : data
          return Promise.resolve({ data: selected, error: null }).then(resolve)
        },
      }
      return query
    },
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

describe('agent contracts and intent classification', () => {
  it('validates bounded requests and rejects empty queries', () => {
    expect(AgentQuerySchema.safeParse({ query: 'hello' }).success).toBe(true)
    expect(AgentQuerySchema.safeParse({ query: ' ' }).success).toBe(false)
    expect(AgentQuerySchema.parse({ query: 'today', referenceTimestamp: '1900-01-01T00:00:00.000Z' })).not.toHaveProperty('referenceTimestamp')
    expect(AgentQuerySchema.parse({ query: 'hello', userId: '00000000-0000-4000-8000-000000000000' })).not.toHaveProperty('userId')
    expect(IntentResultSchema.safeParse({ intent: 'unknown', confidence: 2, rationale: 'bad' }).success).toBe(false)
  })

  it('uses deterministic phrase rules or an injected semantic classifier', async () => {
    expect(classifyIntentDeterministically('What did I decide in a previous chat?').intent).toBe('historical_conversation_recall')
    expect(classifyIntentDeterministically('What is the latest on battery storage?').intent).toBe('current_research')
    const classifier = { classify: vi.fn().mockResolvedValue({ intent: 'historical_research_recall', confidence: 0.91, rationale: 'Prior results requested.' }) }
    expect((await classifyIntent('what did you find?', classifier)).intent).toBe('historical_research_recall')
    expect(classifier.classify).toHaveBeenCalledOnce()
  })
})

describe('temporal resolution', () => {
  const referenceTimestamp = '2026-11-12T19:00:00.000Z' // 00:30 on Nov 13 in Kolkata

  it('resolves relative dates against the user local date, including midnight boundaries', () => {
    const result = resolveTemporalReferences('yesterday and last Tuesday', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(result.references.map(({ start }) => start)).toEqual(['2026-11-12', '2026-11-10'])
  })

  it('resolves last week as the previous Monday to Sunday in local calendar dates', () => {
    expect(resolveTemporalReferences('What happened last week?', { timezone: 'Asia/Kolkata', referenceTimestamp }).references[0]).toMatchObject({ start: '2026-11-02', end: '2026-11-08', kind: 'date_range' })
  })

  it('resolves last month, day offsets, named dates and month-year ranges', () => {
    const result = resolveTemporalReferences('last month, two days ago, November 3, 2025, and November 2025', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(result.references).toMatchObject([
      { kind: 'date_range', start: '2026-10-01', end: '2026-10-31' },
      { kind: 'relative_date', start: '2026-11-11', end: '2026-11-11' },
      { kind: 'absolute_date', start: '2025-11-03', end: '2025-11-03' },
      { kind: 'date_range', start: '2025-11-01', end: '2025-11-30' },
    ])
  })

  it('resolves common multi-day relative expressions deterministically', () => {
    const result = resolveTemporalReferences('day before yesterday and a week ago', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(result.references.map(({ start }) => start)).toEqual(['2026-11-11', '2026-11-06'])
  })

  it('recognizes absolute dates and asks for a missing year instead of guessing', () => {
    const result = resolveTemporalReferences('Compare 2025-11-03 with 3 November', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(result.references[0]).toMatchObject({ kind: 'absolute_date', start: '2025-11-03' })
    expect(result.references[1]).toMatchObject({ kind: 'ambiguous', start: null, end: null })
  })

  it('uses the safe timezone fallback for invalid timezones', () => {
    expect(resolveTemporalReferences('today', { timezone: 'Bad/Zone', referenceTimestamp }).timezone).toBe('Asia/Kolkata')
  })

  it('marks unsupported relative and month-only date expressions ambiguous without treating ordinary month words as dates', () => {
    expect(resolveTemporalReferences('We spoke a few days ago.', { timezone: 'Asia/Kolkata', referenceTimestamp }).references[0]?.kind).toBe('ambiguous')
    expect(resolveTemporalReferences('What changed during November?', { timezone: 'Asia/Kolkata', referenceTimestamp }).references[0]?.kind).toBe('ambiguous')
    expect(resolveTemporalReferences('November', { timezone: 'Asia/Kolkata', referenceTimestamp }).references[0]?.kind).toBe('ambiguous')
    expect(resolveTemporalReferences('three months ago', { timezone: 'Asia/Kolkata', referenceTimestamp }).references[0]).toMatchObject({ kind: 'relative_date', start: '2026-08-13' })
    expect(resolveTemporalReferences('The March product launch is ready.', { timezone: 'Asia/Kolkata', referenceTimestamp }).references).toEqual([])
  })

  it('uses the most recent completed weekday occurrence and clarifies same-day ambiguity', () => {
    const reference = '2026-11-11T12:00:00.000Z' // Wednesday in UTC
    expect(resolveTemporalReferences('What did we discuss Monday?', { timezone: 'UTC', referenceTimestamp: reference }).references[0]).toMatchObject({ kind: 'relative_date', start: '2026-11-09' })
    expect(resolveTemporalReferences('What happened Wednesday?', { timezone: 'UTC', referenceTimestamp: reference }).references[0]).toMatchObject({ kind: 'ambiguous', start: null })
    expect(resolveTemporalReferences('Show me what I asked Friday.', { timezone: 'UTC', referenceTimestamp: reference }).references[0]).toMatchObject({ kind: 'relative_date', start: '2026-11-06' })
    expect(resolveTemporalReferences('What happened last Tuesday?', { timezone: 'UTC', referenceTimestamp: reference }).references[0]).toMatchObject({ kind: 'relative_date', start: '2026-11-10' })
  })

  it('uses local calendar dates across daylight-saving transitions', () => {
    const beforeSpringShift = resolveTemporalReferences('yesterday', { timezone: 'America/New_York', referenceTimestamp: '2026-03-08T06:30:00.000Z' })
    const afterSpringShift = resolveTemporalReferences('today', { timezone: 'America/New_York', referenceTimestamp: '2026-03-08T07:30:00.000Z' })
    const fallShift = resolveTemporalReferences('yesterday', { timezone: 'America/New_York', referenceTimestamp: '2026-11-01T05:30:00.000Z' })
    expect(beforeSpringShift.references[0].start).toBe('2026-03-07')
    expect(afterSpringShift.references[0].start).toBe('2026-03-08')
    expect(fallShift.references[0].start).toBe('2026-10-31')
    const springStart = Date.parse(localDateStartUtc('2026-03-08', 'America/New_York'))
    const springEnd = Date.parse(localDateStartUtc('2026-03-09', 'America/New_York'))
    const fallStart = Date.parse(localDateStartUtc('2026-11-01', 'America/New_York'))
    const fallEnd = Date.parse(localDateStartUtc('2026-11-02', 'America/New_York'))
    expect(springEnd - springStart).toBe(23 * 60 * 60 * 1000)
    expect(fallEnd - fallStart).toBe(25 * 60 * 60 * 1000)
  })

  it('builds half-open local-date retrieval intervals and uses the requested historical source', () => {
    const temporal = resolveTemporalReferences('What did I say yesterday?', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(createTemporalRetrievalFilter(temporal, 'historical_conversation_recall', 'What did I say yesterday?')).toMatchObject({
      target: 'messages', timezone: 'Asia/Kolkata', intervals: [{ startAt: '2026-11-11T18:30:00.000Z', endAt: '2026-11-12T18:30:00.000Z' }],
    })
    const research = resolveTemporalReferences('What research did I do last week?', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(createTemporalRetrievalFilter(research, 'historical_research_recall', 'What research did I do last week?')?.target).toBe('research_snapshots')
    const tuesday = resolveTemporalReferences('What did we discuss last Tuesday?', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(createTemporalRetrievalFilter(tuesday, 'historical_conversation_recall', 'What did we discuss last Tuesday?')?.intervals).toEqual([{ startAt: '2026-11-09T18:30:00.000Z', endAt: '2026-11-10T18:30:00.000Z' }])
    const validTime = resolveTemporalReferences('What was true about this product last year?', { timezone: 'Asia/Kolkata', referenceTimestamp })
    expect(createTemporalRetrievalFilter(validTime, 'general_conversational', 'What was true about this product last year?')).toMatchObject({ target: 'memory_valid_time', intervals: [{ startAt: '2024-12-31T18:30:00.000Z', endAt: '2025-12-31T18:30:00.000Z' }] })
  })

  it('resolves relative spans, leap days, and year boundaries without using the machine date', () => {
    expect(resolveTemporalReferences('in two days and three weeks from now', { timezone: 'UTC', referenceTimestamp: '2024-12-31T23:30:00.000Z' }).references.map(({ start }) => start)).toEqual(['2025-01-02', '2025-01-21'])
    expect(resolveTemporalReferences('February 29, 2024', { timezone: 'UTC', referenceTimestamp }).references[0]).toMatchObject({ start: '2024-02-29', kind: 'absolute_date' })
    expect(resolveTemporalReferences('February 29, 2025', { timezone: 'UTC', referenceTimestamp }).references[0].kind).toBe('ambiguous')
  })

  it('resolves “last November” while leaving a topical November reference alone', () => {
    expect(resolveTemporalReferences('What did I ask last November?', { timezone: 'UTC', referenceTimestamp: '2026-11-13T12:00:00.000Z' }).references[0]).toMatchObject({ kind: 'date_range', start: '2025-11-01', end: '2025-11-30' })
    expect(resolveTemporalReferences('November product launch', { timezone: 'UTC', referenceTimestamp }).references).toEqual([])
  })
})

describe('search planning', () => {
  it('does not search for general chat and marks absent history as missing', () => {
    expect(createSearchPlan({ intent: 'general_conversational', query: 'hello', hasHistoricalContext: false }).shouldSearchWeb).toBe(false)
    expect(createSearchPlan({ intent: 'historical_research_recall', query: 'what did we find?', hasHistoricalContext: false }).historicalInformationMissing).toHaveLength(1)
  })

  it('plans current evidence and caps Tavily calls at eight', () => {
    expect(createSearchPlan({ intent: 'current_research', query: 'latest market rules', hasHistoricalContext: false, maxCalls: 30 })).toMatchObject({ shouldSearchWeb: true, maxCalls: 8 })
    expect(createSearchPlan({ intent: 'current_research', query: 'latest market rules', hasHistoricalContext: false, maxCalls: 0 }).shouldSearchWeb).toBe(false)
  })
})

describe('historical repository ownership boundary', () => {
  it('ranks relevance before recency with stable id tie-breaks', () => {
    const rows = [
      { id: 'b', created_at: '2026-01-03T00:00:00.000Z', content: 'project notes' },
      { id: 'c', created_at: '2026-01-02T00:00:00.000Z', content: 'launch for project notes' },
      { id: 'a', created_at: '2026-01-02T00:00:00.000Z', content: 'launch for project notes' },
    ]
    expect(rankHistoricalRows(rows, 'project launch', (row) => row.content, 3).map((row) => row.id)).toEqual(['a', 'c', 'b'])
  })

  it('adds the authenticated user id to each user-owned top-level retrieval', async () => {
    const ownershipFilters: Array<{ table: string; column: string; value: unknown }> = []
    const client = {
      from(table: string) {
        const query = {
          select() { return query },
          eq(column: string, value: unknown) { if (column === 'user_id') ownershipFilters.push({ table, column, value }); return query },
          textSearch() { return query }, order() { return query }, range() { return query }, limit() { return query }, in() { return query },
          then(resolve: (value: { data: never[]; error: null }) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve) },
        }
        return query
      },
    } as unknown as SupabaseClient<Database>
    await new SupabaseHistoricalRepository(client).retrieve({ userId: context.userId, query: 'project update' })
    expect(ownershipFilters).toHaveLength(3)
    expect(ownershipFilters.every(({ value }) => value === context.userId)).toBe(true)
  })

  it('normalizes useful search terms and requests stable claim/source ordering', async () => {
    expect(buildHistoricalSearchQuery('What did we discuss about Café Project Launch?')).toBe('cafe OR project OR launch')
    const orderCalls: Array<{ table: string; column: string; ascending: boolean }> = []
    const searchCalls: Array<{ table: string; query: string }> = []
    const snapshotId = '8d1e4570-f5e5-4e55-a8f7-65791122a2fb'
    const claimId = 'b879e41c-5110-485f-a9be-7cd85a2b8ad9'
    const rows: Record<string, unknown[]> = {
      messages: [], memory_items: [],
      research_snapshots: [{ id: snapshotId, query: 'project launch', status: 'completed', created_at: '2026-01-01T00:00:00.000Z' }],
      research_claims: [{ id: claimId, snapshot_id: snapshotId, entity_name: 'Project', claim_text: 'It launched.', valid_at: null, recorded_at: '2026-01-01T00:00:00.000Z' }],
      research_sources: [{ id: '7900b6fb-fb42-4138-9f49-aa304f9482ef', claim_id: claimId, url: 'https://example.com', title: 'Project', snippet: 'Launch', retrieved_at: '2026-01-01T00:00:00.000Z' }],
    }
    const client = {
      from(table: string) {
        const query = {
          select() { return query }, eq() { return query }, textSearch(_column: string, search: string) { searchCalls.push({ table, query: search }); return query },
          order(column: string, options: { ascending: boolean }) { orderCalls.push({ table, column, ascending: options.ascending }); return query },
          range() { return query }, limit() { return query }, in() { return query },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) { return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve) },
        }
        return query
      },
    } as unknown as SupabaseClient<Database>
    await new SupabaseHistoricalRepository(client).retrieve({ userId: context.userId, query: 'project launch' })
    expect(searchCalls).toEqual([
      { table: 'messages', query: 'project OR launch' },
      { table: 'memory_items', query: 'project OR launch' },
      { table: 'research_snapshots', query: 'project OR launch' },
    ])
    expect(orderCalls).toContainEqual({ table: 'research_claims', column: 'recorded_at', ascending: false })
    expect(orderCalls).toContainEqual({ table: 'research_claims', column: 'id', ascending: true })
    expect(orderCalls).toContainEqual({ table: 'research_sources', column: 'retrieved_at', ascending: false })
    expect(orderCalls).toContainEqual({ table: 'research_sources', column: 'id', ascending: true })
  })

  it('builds actual message timestamp and ownership filters and leaves ordinary queries unfiltered by date', async () => {
    const interval = { startAt: '2026-11-11T18:30:00.000Z', endAt: '2026-11-12T18:30:00.000Z' }
    const conversationId = '4e63cb00-88fd-4bb5-b271-e6a00e146a2b'
    const { client, calls } = makeQueryMock()
    await new SupabaseHistoricalRepository(client).retrieve({
      userId: context.userId, query: 'What did I ask yesterday?', conversationId,
      temporalTerms: ['yesterday'], temporalFilter: { target: 'messages', timezone: 'Asia/Kolkata', intervals: [interval] },
    })
    expect(calls).toContainEqual({ table: 'messages', method: 'eq', args: ['user_id', context.userId] })
    expect(calls).toContainEqual({ table: 'messages', method: 'eq', args: ['conversation_id', conversationId] })
    expect(calls).toContainEqual({ table: 'messages', method: 'gte', args: ['created_at', interval.startAt] })
    expect(calls).toContainEqual({ table: 'messages', method: 'lt', args: ['created_at', interval.endAt] })
    expect(calls).toContainEqual({ table: 'messages', method: 'range', args: [0, HISTORICAL_CANDIDATE_LIMIT - 1] })

    const ordinary = makeQueryMock()
    await new SupabaseHistoricalRepository(ordinary.client).retrieve({ userId: context.userId, query: 'November product launch' })
    expect(ordinary.calls).toContainEqual({ table: 'messages', method: 'textSearch', args: ['content', 'november OR product OR launch', { type: 'websearch', config: 'english' }] })
    expect(ordinary.calls.some(({ method }) => method === 'gte' || method === 'lt' || method === 'or')).toBe(false)
  })

  it('builds snapshot completed_at and unfinished created_at fallback filters', async () => {
    const interval = { startAt: '2026-11-02T00:00:00.000Z', endAt: '2026-11-09T00:00:00.000Z' }
    const conversationId = '4e63cb00-88fd-4bb5-b271-e6a00e146a2b'
    const mock = makeQueryMock()
    await new SupabaseHistoricalRepository(mock.client).retrieve({
      userId: context.userId, query: 'What research last week?', conversationId,
      temporalTerms: ['last week'], temporalFilter: { target: 'research_snapshots', timezone: 'UTC', intervals: [interval] },
    })
    expect(mock.calls).toContainEqual({ table: 'research_snapshots', method: 'eq', args: ['user_id', context.userId] })
    expect(mock.calls).toContainEqual({ table: 'research_snapshots', method: 'eq', args: ['conversation_id', conversationId] })
    expect(mock.calls).toContainEqual({ table: 'research_snapshots', method: 'or', args: [`and(completed_at.gte.${interval.startAt},completed_at.lt.${interval.endAt}),and(completed_at.is.null,created_at.gte.${interval.startAt},created_at.lt.${interval.endAt})`] })
  })

  it('builds memory valid-time overlap filters with open-ended interval support', async () => {
    const interval = { startAt: '2025-01-01T00:00:00.000Z', endAt: '2026-01-01T00:00:00.000Z' }
    const mock = makeQueryMock()
    await new SupabaseHistoricalRepository(mock.client).retrieve({
      userId: context.userId, query: 'What was true about the product last year?', temporalTerms: ['last year'],
      temporalFilter: { target: 'memory_valid_time', timezone: 'UTC', intervals: [interval] },
    })
    expect(mock.calls).toContainEqual({ table: 'memory_items', method: 'eq', args: ['user_id', context.userId] })
    expect(mock.calls).toContainEqual({ table: 'memory_items', method: 'or', args: [`and(or(valid_to.is.null,valid_to.gt.${interval.startAt}),or(valid_from.is.null,valid_from.lt.${interval.endAt}))`] })
  })

  it('lets a relevant older row beat newer weaker candidates inside the bounded candidate window', async () => {
    const rows = Array.from({ length: HISTORICAL_CANDIDATE_LIMIT }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      conversation_id: '4e63cb00-88fd-4bb5-b271-e6a00e146a2b',
      role: 'user',
      content: index === HISTORICAL_CANDIDATE_LIMIT - 1 ? 'Project launch plan and milestones' : 'Project update',
      created_at: new Date(Date.parse('2026-11-13T00:00:00.000Z') - index * 86_400_000).toISOString(),
    }))
    const mock = makeQueryMock({ messages: rows })
    const result = await new SupabaseHistoricalRepository(mock.client).retrieve({ userId: context.userId, query: 'Project launch' })
    expect(mock.calls).toContainEqual({ table: 'messages', method: 'range', args: [0, HISTORICAL_CANDIDATE_LIMIT - 1] })
    expect(result.messages[0].id).toBe(rows[HISTORICAL_CANDIDATE_LIMIT - 1].id)
    expect(HISTORICAL_CANDIDATE_LIMIT).toBe(200)
  })

  it('removes only successfully parsed temporal phrases from topical search terms', async () => {
    const mock = makeQueryMock()
    await new SupabaseHistoricalRepository(mock.client).retrieve({
      userId: context.userId, query: 'What did I ask last November?', temporalTerms: ['last November'],
      temporalFilter: { target: 'messages', timezone: 'UTC', intervals: [{ startAt: '2025-11-01T00:00:00.000Z', endAt: '2025-12-01T00:00:00.000Z' }] },
    })
    expect(mock.calls).toContainEqual({ table: 'messages', method: 'textSearch', args: ['content', 'ask', { type: 'websearch', config: 'english' }] })
  })
})

describe('orchestration sequence and errors', () => {
  it('classifies, resolves time, then retrieves history and produces a bounded plan', async () => {
    const order: string[] = []
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => { order.push('retrieve'); return emptyHistory }) }
    const classifier = { classify: vi.fn(async () => { order.push('classify'); return { intent: 'current_research' as const, confidence: 0.9, rationale: 'Current fact requested.' } }) }
    const result = await executeAgent({ query: 'What is the latest status?' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { classifier, repository })
    expect(order).toEqual(['classify', 'retrieve'])
    expect(result).toMatchObject({ status: 'planned', searchPlan: { shouldSearchWeb: true, maxCalls: 8 }, answer: null })
  })

  it('passes the resolved temporal filter to historical retrieval', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => emptyHistory) }
    await executeAgent({ query: 'What did I say yesterday?' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { repository })
    expect(repository.retrieve).toHaveBeenCalledWith(expect.objectContaining({ temporalFilter: expect.objectContaining({ target: 'messages', intervals: [{ startAt: '2026-11-11T18:30:00.000Z', endAt: '2026-11-12T18:30:00.000Z' }] }) }))
  })

  it('stops for ambiguous dates without retrieving history', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => emptyHistory) }
    const result = await executeAgent({ query: 'What happened on 3 November?' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { repository })
    expect(result.status).toBe('needs_clarification')
    expect(repository.retrieve).not.toHaveBeenCalled()
  })

  it('stops for unsupported date-like phrases before retrieval or planning', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => emptyHistory) }
    const result = await executeAgent({ query: 'What changed a few days ago?' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { repository })
    expect(result.status).toBe('needs_clarification')
    expect(result.searchPlan).toBeNull()
    expect(repository.retrieve).not.toHaveBeenCalled()
  })

  it('stops an ambiguous unqualified weekday before retrieval or planning', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => emptyHistory) }
    const result = await executeAgent({ query: 'What happened Wednesday?' }, { ...context, timezone: 'UTC', referenceTimestamp: '2026-11-11T12:00:00.000Z' }, { repository })
    expect(result.status).toBe('needs_clarification')
    expect(result.searchPlan).toBeNull()
    expect(repository.retrieve).not.toHaveBeenCalled()
  })

  it('returns sanitized errors when a provider fails', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => emptyHistory) }
    const classifier = { classify: vi.fn(async () => { throw new Error('provider HTTP 429 secret') }) }
    const result = await executeAgent({ query: 'latest news' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { classifier, repository })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR', message: 'Research providers are temporarily unavailable.' } })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('preserves bounded provider retry timing without provider details', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => emptyHistory) }
    const classifier = { classify: vi.fn(async () => { throw new ProviderRequestError('rate_limited', 120) }) }
    const result = await executeAgent({ query: 'latest news' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { classifier, repository })
    expect(result.error).toMatchObject({ code: 'PROVIDER_ERROR', retryAfterSeconds: 120 })
  })

  it('returns a safe retrieval error', async () => {
    const repository: HistoricalRepository = { retrieve: vi.fn(async () => { throw new Error('Historical retrieval failed. raw database detail') }) }
    const result = await executeAgent({ query: 'hello' }, { ...context, referenceTimestamp: '2026-11-12T19:00:00.000Z' }, { repository })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RETRIEVAL_ERROR', message: 'Historical context could not be retrieved.' } })
  })
})
