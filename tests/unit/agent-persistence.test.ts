import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { SupabaseResearchPersistenceRepository } from '@/lib/agent/persistence'
import type { ResearchPersistenceRepository } from '@/lib/agent/persistence'

const snapshotId = '8d1e4570-f5e5-4e55-a8f7-65791122a2fb'
const conversationId = '4e63cb00-88fd-4bb5-b271-e6a00e146a2b'
const input: Parameters<ResearchPersistenceRepository['persist']>[0] = {
  userId: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9', query: 'Latest product pricing?', observedAt: '2026-11-13T12:00:00.000Z',
  searchExecution: { attemptedCalls: 1, completedCalls: 1, totalDurationMs: 50, budgetExhausted: false, outcomes: [{ query: 'pricing', status: 'succeeded', resultCount: 1, failure: null }] },
  evidenceSources: [{ id: 'web-1', kind: 'web', url: 'https://example.com/pricing', title: 'Pricing', snippet: 'Pro costs $20 per month.', domain: 'example.com', publishedAt: { precision: 'date', value: '2026-11-01' }, observedAt: '2026-11-13T12:00:00.000Z', score: 0.9, effectiveAt: null }],
  claims: [{ entityName: 'Acme', claimType: 'pricing', proposition: 'Acme Pro subscription', claimText: 'Pro costs $20 per month.', claimValue: '20', currency: 'USD', billingPeriod: 'monthly', region: 'US', planOrVersion: 'Pro', priceType: 'standard', discountConditions: null, effectiveAt: null, temporalStatus: 'unknown', confidence: 'high', verification: 'supported', sourceIds: ['web-1'] }], comparisons: [],
}

function repositoryMock(error: Error | null = null) {
  let functionName = ''
  let args: Record<string, unknown> | undefined
  const supabase = {
    rpc(name: string, parameters: Record<string, unknown>) {
      functionName = name
      args = parameters
      return { single: async () => error ? { data: null, error } : { data: { snapshot_id: snapshotId, conversation_id: conversationId }, error: null } }
    },
  }
  return { repository: new SupabaseResearchPersistenceRepository(supabase as never), invocation: () => ({ functionName, args }) }
}

describe('snapshot persistence lifecycle', () => {
  it('persists the complete research graph through one atomic authenticated RPC', async () => {
    const mock = repositoryMock()
    await expect(mock.repository.persist(input)).resolves.toEqual({ snapshotId, conversationId })
    const invocation = mock.invocation()
    expect(invocation.functionName).toBe('persist_research_snapshot')
    expect(invocation.args).toMatchObject({
      p_conversation_id: null,
      p_query: input.query,
      p_status: 'completed',
      p_completed_at: expect.any(String),
      p_claims: [{ entity_name: 'Acme', claim_type: 'pricing', claim_text: 'Pro costs $20 per month.', sources: [{ url: 'https://example.com/pricing', published_at: null }] }],
    })
    expect(invocation.args?.p_search_params).toMatchObject({ sourcePublicationDates: [{ sourceId: 'web-1', publishedAt: { precision: 'date', value: '2026-11-01' } }] })
  })

  it('keeps the supplied conversation and represents a failed search in the RPC payload', async () => {
    const mock = repositoryMock()
    await mock.repository.persist({ ...input, conversationId, searchExecution: { ...input.searchExecution, outcomes: [{ ...input.searchExecution.outcomes[0], status: 'failed' }] } })
    expect(mock.invocation().args).toMatchObject({ p_conversation_id: conversationId, p_status: 'failed' })
  })

  it('persists extraction exhaustion as partial even when search succeeded', async () => {
    const mock = repositoryMock()
    await mock.repository.persist({ ...input, status: 'partial', claims: [] })
    expect(mock.invocation().args).toMatchObject({ p_status: 'partial', p_claims: [] })
  })

  it('returns only the safe persistence error when the atomic RPC rejects', async () => {
    const mock = repositoryMock(new Error('private database detail'))
    await expect(mock.repository.persist(input)).rejects.toMatchObject({ name: 'ResearchPersistenceError', cleanupAttempted: false, cleanupSucceeded: true })
  })
})
