import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import type { ClaimComparisonResult, EvidenceSource, ExtractedResearchClaim, SearchExecution } from './contracts'

export class ResearchPersistenceError extends Error {
  constructor() { super('Research snapshot persistence failed.'); this.name = 'ResearchPersistenceError' }
}

export interface ResearchPersistenceRepository {
  persist(input: {
    userId: string; conversationId?: string; query: string; observedAt: string; searchExecution: SearchExecution;
    evidenceSources: EvidenceSource[]; claims: ExtractedResearchClaim[]; comparisons: ClaimComparisonResult[]
  }): Promise<{ snapshotId: string; conversationId: string }>
}

type SingleRow = { data: { id: string; created_at?: string } | null; error: unknown }

export class SupabaseResearchPersistenceRepository implements ResearchPersistenceRepository {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async persist(input: Parameters<ResearchPersistenceRepository['persist']>[0]): Promise<{ snapshotId: string; conversationId: string }> {
    const client = this.supabase as unknown as SupabaseClient
    let conversationId = input.conversationId
    let createdConversationId: string | null = null
    let snapshotId: string | null = null
    try {
      if (!conversationId) {
        const created = await client.from('conversations').insert({ user_id: input.userId, title: input.query.slice(0, 120) }).select('id').single() as unknown as SingleRow
        if (created.error || !created.data) throw new ResearchPersistenceError()
        conversationId = created.data.id
        createdConversationId = conversationId
      }

      const searchParams = {
        observationTime: input.observedAt,
        queries: input.searchExecution.outcomes.map(({ query }) => query),
        attemptedCalls: input.searchExecution.attemptedCalls,
        completedCalls: input.searchExecution.completedCalls,
        totalDurationMs: input.searchExecution.totalDurationMs,
        budgetExhausted: input.searchExecution.budgetExhausted,
        outcomes: input.searchExecution.outcomes,
        sourcePublicationDates: input.evidenceSources.filter((source) => source.kind === 'web' && source.publishedAt).map((source) => ({ sourceId: source.id, url: source.url, publishedAt: source.publishedAt })),
        comparisons: input.comparisons,
      } satisfies Json
      const createdSnapshot = await client.from('research_snapshots').insert({
        user_id: input.userId, conversation_id: conversationId, query: input.query, status: 'pending', search_params: searchParams,
      }).select('id,created_at').single() as unknown as SingleRow
      if (createdSnapshot.error || !createdSnapshot.data) throw new ResearchPersistenceError()
      snapshotId = createdSnapshot.data.id

      const sourceById = new Map(input.evidenceSources.map((source) => [source.id, source]))
      const claimRows = input.claims.map((claim) => ({
        snapshot_id: snapshotId!, entity_name: claim.entityName, claim_type: claim.claimType, claim_text: claim.claimText,
        claim_value: claim.claimValue,
        valid_at: claim.effectiveAt?.precision === 'instant' ? claim.effectiveAt.value : null,
        structured_data: {
          currency: claim.currency, billingPeriod: claim.billingPeriod, region: claim.region, planOrVersion: claim.planOrVersion,
          effectiveDate: claim.effectiveAt, temporalStatus: claim.temporalStatus, confidence: claim.confidence,
          verification: claim.verification, sourceIds: claim.sourceIds,
          comparisons: input.comparisons.filter((comparison) => comparison.currentClaim === claim.claimText),
        } satisfies Json,
      }))
      let claimIds: string[] = []
      if (claimRows.length) {
        const inserted = await client.from('research_claims').insert(claimRows).select('id') as unknown as { data: Array<{ id: string }> | null; error: unknown }
        if (inserted.error || !inserted.data || inserted.data.length !== claimRows.length) throw new ResearchPersistenceError()
        claimIds = inserted.data.map(({ id }) => id)
      }

      const sourceRows = input.claims.flatMap((claim, index) => claim.sourceIds.flatMap((sourceId) => {
        const source = sourceById.get(sourceId)
        if (!source || source.kind !== 'web' || !source.url) return []
        return [{ claim_id: claimIds[index], url: source.url, title: source.title, snippet: source.snippet, domain: source.domain, score: source.score, published_at: source.publishedAt?.precision === 'instant' ? source.publishedAt.value : null }]
      }))
      if (sourceRows.length) {
        const inserted = await client.from('research_sources').insert(sourceRows) as unknown as { error: unknown }
        if (inserted.error) throw new ResearchPersistenceError()
      }

      const status = input.searchExecution.outcomes.some((outcome) => outcome.status === 'failed')
        ? input.evidenceSources.some((source) => source.kind === 'web') ? 'partial' : 'failed'
        : 'completed'
      const completedAt = new Date(Math.max(Date.now(), Date.parse(createdSnapshot.data.created_at ?? new Date().toISOString()))).toISOString()
      const finalized = await client.from('research_snapshots').update({ status, completed_at: completedAt }).eq('id', snapshotId).eq('user_id', input.userId).eq('status', 'pending').select('id').single() as unknown as SingleRow
      if (finalized.error || !finalized.data) throw new ResearchPersistenceError()
      return { snapshotId, conversationId }
    } catch {
      if (snapshotId) {
        try { await client.from('research_snapshots').delete().eq('id', snapshotId).eq('user_id', input.userId).eq('status', 'pending') } catch { /* A pending snapshot is never reported as completed. */ }
      }
      if (createdConversationId) {
        try { await client.from('conversations').delete().eq('id', createdConversationId).eq('user_id', input.userId) } catch { /* Cleanup is best-effort; no credentials or database details are returned. */ }
      }
      throw new ResearchPersistenceError()
    }
  }
}
