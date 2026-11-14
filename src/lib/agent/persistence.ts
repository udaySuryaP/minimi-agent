import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import type { ClaimComparisonResult, EvidenceSource, ExtractedResearchClaim, SearchExecution } from './contracts'

export class ResearchPersistenceError extends Error {
  constructor(readonly cleanupAttempted = false, readonly cleanupSucceeded = true) { super('Research snapshot persistence failed.'); this.name = 'ResearchPersistenceError' }
}

export interface ResearchPersistenceRepository {
  persist(input: {
    userId: string; conversationId?: string; query: string; observedAt: string; searchExecution: SearchExecution;
    evidenceSources: EvidenceSource[]; claims: ExtractedResearchClaim[]; comparisons: ClaimComparisonResult[]; status?: 'completed' | 'failed' | 'partial'
  }): Promise<{ snapshotId: string; conversationId: string }>
}

export class SupabaseResearchPersistenceRepository implements ResearchPersistenceRepository {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async persist(input: Parameters<ResearchPersistenceRepository['persist']>[0]): Promise<{ snapshotId: string; conversationId: string }> {
    const client = this.supabase as unknown as SupabaseClient
    try {
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
      const sourceById = new Map(input.evidenceSources.map((source) => [source.id, source]))
      const claims = input.claims.map((claim) => ({
        entity_name: claim.entityName,
        claim_type: claim.claimType,
        claim_text: claim.claimText,
        claim_value: claim.claimValue,
        valid_at: claim.effectiveAt?.precision === 'instant' ? claim.effectiveAt.value : null,
        structured_data: {
          proposition: claim.proposition, currency: claim.currency, billingPeriod: claim.billingPeriod, region: claim.region,
          planOrVersion: claim.planOrVersion, priceType: claim.priceType, discountConditions: claim.discountConditions,
          effectiveDate: claim.effectiveAt, temporalStatus: claim.temporalStatus, confidence: claim.confidence,
          verification: claim.verification, sourceIds: claim.sourceIds,
          comparisons: input.comparisons.filter((comparison) => comparison.currentClaim === claim.claimText),
        },
        sources: claim.sourceIds.flatMap((sourceId) => {
          const source = sourceById.get(sourceId)
          if (!source || source.kind !== 'web' || !source.url) return []
          return [{ url: source.url, title: source.title, snippet: source.snippet, domain: source.domain, score: source.score, published_at: source.publishedAt?.precision === 'instant' ? source.publishedAt.value : null }]
        }),
      })) satisfies Json
      const failedCalls = input.searchExecution.outcomes.some((outcome) => outcome.status === 'failed')
      const successfulCalls = input.searchExecution.outcomes.some((outcome) => outcome.status === 'succeeded')
      const status = input.status ?? (input.searchExecution.attemptedCalls === 0 || !successfulCalls ? 'failed' : failedCalls ? 'partial' : 'completed')
      const persisted = await client.rpc('persist_research_snapshot', {
        p_conversation_id: input.conversationId ?? null,
        p_query: input.query,
        p_search_params: searchParams,
        p_claims: claims,
        p_status: status,
        p_completed_at: new Date().toISOString(),
      }).single() as unknown as { data: { snapshot_id: string; conversation_id: string } | null; error: unknown }
      if (persisted.error || !persisted.data) throw new ResearchPersistenceError()
      return { snapshotId: persisted.data.snapshot_id, conversationId: persisted.data.conversation_id }
    } catch {
      throw new ResearchPersistenceError(false, true)
    }
  }
}
