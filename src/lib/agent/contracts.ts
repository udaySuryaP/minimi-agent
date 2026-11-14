import { z } from 'zod'

export const AgentQuerySchema = z.object({
  query: z.string().trim().min(1).max(4000),
  conversationId: z.uuid().optional(),
})
export type AgentQuery = z.infer<typeof AgentQuerySchema>

export const ExecutionContextSchema = z.object({
  userId: z.uuid(),
  timezone: z.string().min(1).max(50),
  referenceTimestamp: z.iso.datetime({ offset: true }),
})
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>

export const IntentSchema = z.enum([
  'historical_conversation_recall',
  'historical_research_recall',
  'current_research',
  'historical_current_comparison',
  'general_conversational',
])
export type Intent = z.infer<typeof IntentSchema>
export const IntentResultSchema = z.object({ intent: IntentSchema, confidence: z.number().min(0).max(1), rationale: z.string().max(500) })
export type IntentResult = z.infer<typeof IntentResultSchema>

export const TemporalResolutionSchema = z.object({
  references: z.array(z.object({
    text: z.string(), kind: z.enum(['absolute_date', 'relative_date', 'date_range', 'ambiguous', 'unspecified']),
    start: z.iso.date().nullable(), end: z.iso.date().nullable(), ambiguity: z.string().nullable(),
  })),
  timezone: z.string(), referenceTimestamp: z.iso.datetime({ offset: true }),
})
export type TemporalResolution = z.infer<typeof TemporalResolutionSchema>

export const TemporalRetrievalFilterSchema = z.object({
  target: z.enum(['messages', 'research_snapshots', 'memory_valid_time', 'all']),
  timezone: z.string().min(1).max(50),
  intervals: z.array(z.object({
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }),
  }).refine((interval) => Date.parse(interval.endAt) >= Date.parse(interval.startAt))).min(1),
})
export type TemporalRetrievalFilter = z.infer<typeof TemporalRetrievalFilterSchema>

export const HistoricalMessageSchema = z.object({ id: z.uuid(), conversationId: z.uuid(), role: z.enum(['user', 'assistant', 'system']), content: z.string(), createdAt: z.iso.datetime({ offset: true }) })
export const MemoryItemSchema = z.object({ id: z.uuid(), entityName: z.string(), content: z.string(), validFrom: z.iso.datetime({ offset: true }).nullable(), validTo: z.iso.datetime({ offset: true }).nullable(), createdAt: z.iso.datetime({ offset: true }) })
export const PublishedDateSchema = z.discriminatedUnion('precision', [
  z.object({ precision: z.literal('date'), value: z.iso.date() }),
  z.object({ precision: z.literal('instant'), value: z.iso.datetime({ offset: true }) }),
])
export type PublishedDate = z.infer<typeof PublishedDateSchema>
export const ResearchClaimTypeSchema = z.enum(['pricing', 'feature', 'announcement', 'comparison', 'general'])
export const ResearchSourceSchema = z.object({ id: z.uuid(), url: z.url(), title: z.string().nullable(), snippet: z.string().nullable(), domain: z.string().nullable().default(null), score: z.number().nullable().default(null), publishedAt: z.iso.datetime({ offset: true }).nullable().default(null), retrievedAt: z.iso.datetime({ offset: true }) })
export const ResearchClaimSchema = z.object({ id: z.uuid(), snapshotId: z.uuid(), entityName: z.string(), claimType: ResearchClaimTypeSchema.default('general'), claimText: z.string(), claimValue: z.string().nullable().default(null), structuredData: z.record(z.string(), z.unknown()).default({}), validAt: z.iso.datetime({ offset: true }).nullable(), recordedAt: z.iso.datetime({ offset: true }), sources: z.array(ResearchSourceSchema) })
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>
export const ResearchSnapshotSchema = z.object({ id: z.uuid(), query: z.string(), status: z.enum(['pending', 'completed', 'failed', 'partial']), createdAt: z.iso.datetime({ offset: true }), claims: z.array(ResearchClaimSchema) })
export const HistoricalRetrievalSchema = z.object({ messages: z.array(HistoricalMessageSchema), memoryItems: z.array(MemoryItemSchema), researchSnapshots: z.array(ResearchSnapshotSchema) })
export type HistoricalRetrieval = z.infer<typeof HistoricalRetrievalSchema>

export const SearchPlanSchema = z.object({ shouldSearchWeb: z.boolean(), historicalInformationMissing: z.array(z.string()), currentQuestions: z.array(z.string()), maxCalls: z.number().int().min(0).max(8), stopReason: z.string() })
export type SearchPlan = z.infer<typeof SearchPlanSchema>
export const WebSearchResultSchema = z.object({ query: z.string(), results: z.array(z.object({ title: z.string().nullable(), url: z.url(), snippet: z.string(), publishedAt: PublishedDateSchema.nullable(), score: z.number().min(0).max(1).nullable().default(null) })) })
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>

export const SearchFailureSchema = z.object({ kind: z.enum(['rate_limited', 'request_failed', 'timeout']), retryAfterSeconds: z.number().int().min(0).max(3600).nullable() })
export const SearchCallOutcomeSchema = z.object({ query: z.string(), status: z.enum(['succeeded', 'failed']), resultCount: z.number().int().min(0), failure: SearchFailureSchema.nullable() })
export const SearchExecutionSchema = z.object({ attemptedCalls: z.number().int().min(0).max(8), completedCalls: z.number().int().min(0).max(8), totalDurationMs: z.number().int().min(0), budgetExhausted: z.boolean(), outcomes: z.array(SearchCallOutcomeSchema).max(8) }).refine((value) => value.completedCalls === value.outcomes.length && value.attemptedCalls >= value.completedCalls)
export type SearchExecution = z.infer<typeof SearchExecutionSchema>

export const EvidenceSourceSchema = z.object({
  id: z.string().min(1).max(100), kind: z.enum(['web', 'historical_message', 'historical_memory', 'historical_research']),
  url: z.url().nullable(), title: z.string().nullable(), snippet: z.string().max(12000), domain: z.string().nullable(),
  publishedAt: PublishedDateSchema.nullable(), observedAt: z.iso.datetime({ offset: true }), score: z.number().min(0).max(1).nullable(),
  effectiveAt: PublishedDateSchema.nullable().default(null),
})
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>

export const ExtractedResearchClaimSchema = z.object({
  entityName: z.string().min(1).max(200), claimType: ResearchClaimTypeSchema, claimText: z.string().min(1).max(2000), claimValue: z.string().max(200).nullable().default(null),
  currency: z.string().max(12).nullable().default(null), billingPeriod: z.string().max(80).nullable().default(null), region: z.string().max(100).nullable().default(null),
  planOrVersion: z.string().max(150).nullable().default(null), effectiveAt: PublishedDateSchema.nullable().default(null),
  temporalStatus: z.enum(['historical', 'current']).default('current'), confidence: z.enum(['high', 'medium', 'low']),
  verification: z.enum(['supported', 'uncertain', 'unverified']).default('supported'), sourceIds: z.array(z.string().min(1).max(100)).min(1).max(8),
})
export type ExtractedResearchClaim = z.infer<typeof ExtractedResearchClaimSchema>

export const ComparisonOutcomeSchema = z.enum(['changed', 'unchanged', 'new_information', 'historical_unverified', 'conflicting', 'insufficient_evidence'])
export const ClaimComparisonResultSchema = z.object({ historicalClaim: z.string().nullable(), currentClaim: z.string().nullable(), outcome: ComparisonOutcomeSchema, explanation: z.string().max(1000), sourceIds: z.array(z.string()) })
export type ClaimComparisonResult = z.infer<typeof ClaimComparisonResultSchema>

export const EvidenceSchema = z.object({ sourceId: z.string(), quote: z.string(), url: z.url().nullable() })
export const ClaimSchema = z.object({ text: z.string(), validAt: z.iso.datetime({ offset: true }).nullable(), evidence: z.array(EvidenceSchema) })
export const ClaimComparisonSchema = z.object({ historicalClaim: ClaimSchema, currentClaim: ClaimSchema.nullable(), outcome: z.enum(['unchanged', 'changed', 'unverified', 'conflicting']) })
export const CitationSchema = z.object({ id: z.string(), title: z.string(), url: z.url() })
export const FinalAnswerSchema = z.object({ text: z.string(), citations: z.array(CitationSchema), claims: z.array(ClaimSchema) })
export type FinalAnswer = z.infer<typeof FinalAnswerSchema>
export const AgentErrorSchema = z.object({ code: z.enum(['INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNAUTHENTICATED', 'PROVIDER_ERROR', 'RETRIEVAL_ERROR', 'PERSISTENCE_ERROR', 'INTERNAL_ERROR']), message: z.string(), retryAfterSeconds: z.number().int().min(0).max(3600).optional() })
export const AgentExecutionSchema = z.object({ status: z.enum(['planned', 'needs_clarification', 'completed', 'failed']), intent: IntentResultSchema.nullable(), temporal: TemporalResolutionSchema.nullable(), history: HistoricalRetrievalSchema.nullable(), searchPlan: SearchPlanSchema.nullable(), searchExecution: SearchExecutionSchema.nullable().default(null), evidenceSources: z.array(EvidenceSourceSchema).default([]), extractedClaims: z.array(ExtractedResearchClaimSchema).default([]), comparisons: z.array(ClaimComparisonResultSchema).default([]), snapshotId: z.uuid().nullable().default(null), answer: FinalAnswerSchema.nullable(), error: AgentErrorSchema.nullable() })
export type AgentExecution = z.infer<typeof AgentExecutionSchema>
