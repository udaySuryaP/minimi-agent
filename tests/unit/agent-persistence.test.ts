import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { SupabaseResearchPersistenceRepository } from '@/lib/agent/persistence'
import type { ResearchPersistenceRepository } from '@/lib/agent/persistence'

const userId = 'b879e41c-5110-485f-a9be-7cd85a2b8ad9'
const snapshotId = '8d1e4570-f5e5-4e55-a8f7-65791122a2fb'
const conversationId = '4e63cb00-88fd-4bb5-b271-e6a00e146a2b'
const input: Parameters<ResearchPersistenceRepository['persist']>[0] = {
  userId, query: 'Latest product pricing?', observedAt: '2026-11-13T12:00:00.000Z',
  searchExecution: { attemptedCalls: 1, completedCalls: 1, totalDurationMs: 50, budgetExhausted: false, outcomes: [{ query: 'pricing', status: 'succeeded', resultCount: 1, failure: null }] },
  evidenceSources: [{ id: 'web-1', kind: 'web', url: 'https://example.com/pricing', title: 'Pricing', snippet: 'Pro costs $20 per month.', domain: 'example.com', publishedAt: { precision: 'date', value: '2026-11-01' }, observedAt: '2026-11-13T12:00:00.000Z', score: 0.9, effectiveAt: null }],
  claims: [{ entityName: 'Acme', claimType: 'pricing', claimText: 'Pro costs $20 per month.', claimValue: '20', currency: 'USD', billingPeriod: 'monthly', region: 'US', planOrVersion: 'Pro', effectiveAt: null, temporalStatus: 'current', confidence: 'high', verification: 'supported', sourceIds: ['web-1'] }], comparisons: [],
}

function repositoryMock(failOn?: string) {
  const calls: Array<{ table: string; action: string; payload?: unknown; filters: unknown[] }> = []
  let table = ''
  let action = ''
  let payload: unknown
  let filters: unknown[] = []
  const builder = {
    insert(value: unknown) { action = 'insert'; payload = value; calls.push({ table, action, payload, filters: [] }); return this },
    update(value: unknown) { action = 'update'; payload = value; calls.push({ table, action, payload, filters: [] }); return this },
    delete() { action = 'delete'; payload = undefined; calls.push({ table, action, filters: [] }); return this },
    select() { return this },
    eq(...args: unknown[]) { filters = [...filters, args]; const latest = calls[calls.length - 1]; if (latest) latest.filters.push(args); return this },
    single: async () => {
      if (failOn === `${table}:${action}`) return { data: null, error: new Error('private database detail') }
      if (table === 'conversations') return { data: { id: conversationId }, error: null }
      if (table === 'research_snapshots' && action === 'insert') return { data: { id: snapshotId, created_at: '2026-11-13T12:00:00.000Z' }, error: null }
      return { data: { id: snapshotId }, error: null }
    },
    then(resolve: (value: unknown) => unknown) {
      const data = table === 'research_claims' ? [{ id: 'claim-id' }] : null
      return Promise.resolve(failOn === `${table}:${action}` ? { data: null, error: new Error('private database detail') } : { data, error: null }).then(resolve)
    },
  }
  const supabase = { from(name: string) { table = name; action = ''; payload = undefined; filters = []; return builder } }
  return { calls, repository: new SupabaseResearchPersistenceRepository(supabase as never) }
}

describe('snapshot persistence lifecycle', () => {
  it('creates a new pending snapshot, inserts linked evidence and finalizes it without changing earlier snapshots', async () => {
    const mock = repositoryMock()
    const result = await mock.repository.persist(input)
    expect(result).toEqual({ snapshotId, conversationId })
    expect(mock.calls.map(({ table, action }) => `${table}:${action}`)).toEqual(['conversations:insert', 'research_snapshots:insert', 'research_claims:insert', 'research_sources:insert', 'research_snapshots:update'])
    const snapshotInsert = mock.calls.find(({ table, action }) => table === 'research_snapshots' && action === 'insert')!
    expect(snapshotInsert.payload).toMatchObject({ user_id: userId, conversation_id: conversationId, status: 'pending' })
    const finalUpdate = mock.calls.find(({ table, action }) => table === 'research_snapshots' && action === 'update')!
    expect(finalUpdate.payload).toMatchObject({ status: 'completed', completed_at: expect.any(String) })
    expect(finalUpdate.filters).toContainEqual(['user_id', userId])
    const sourceInsert = mock.calls.find(({ table }) => table === 'research_sources')!
    expect(sourceInsert.payload).toMatchObject([{ claim_id: expect.any(String), url: 'https://example.com/pricing', published_at: null }])
  })

  it('uses the supplied conversation and cleans up a pending snapshot on a child insert failure', async () => {
    const mock = repositoryMock('research_sources:insert')
    await expect(mock.repository.persist({ ...input, conversationId })).rejects.toMatchObject({ name: 'ResearchPersistenceError' })
    expect(mock.calls.some(({ table }) => table === 'conversations')).toBe(false)
    expect(mock.calls.some(({ table, action }) => table === 'research_snapshots' && action === 'delete')).toBe(true)
  })

  it('returns only a safe persistence error when snapshot creation fails', async () => {
    const mock = repositoryMock('research_snapshots:insert')
    await expect(mock.repository.persist({ ...input, conversationId })).rejects.toThrow('Research snapshot persistence failed.')
    expect(mock.calls.some(({ table, action }) => table === 'research_snapshots' && action === 'delete')).toBe(false)
  })
})
