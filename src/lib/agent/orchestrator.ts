import { AgentExecutionSchema, ExecutionContextSchema, type AgentExecution, type AgentQuery, type ExecutionContext, type HistoricalRetrieval } from './contracts'
import { classifyIntent, type IntentClassifier } from './intent'
import { createTemporalRetrievalFilter, resolveTemporalReferences } from './temporal'
import { createSearchPlan } from './search-plan'
import type { HistoricalRepository } from './retrieval'
import { ProviderRequestError } from './provider-errors'
import type { ResearchReasoner, TavilyProvider } from './providers'
import { executeSearchPlan, getSearchExecutionLimits, type SearchExecutionLimits } from './search-executor'
import { buildHistoricalEvidence, buildWebEvidence } from './evidence'
import { compareHistoricalAndCurrent } from './comparison'
import type { ResearchPersistenceRepository } from './persistence'

export interface AgentDependencies {
  classifier?: IntentClassifier
  repository: HistoricalRepository
  maxSearchCalls?: number
  reasoner?: ResearchReasoner
  tavily?: TavilyProvider
  persistence?: ResearchPersistenceRepository
  searchLimits?: SearchExecutionLimits
}

export async function executeAgent(query: AgentQuery, executionContext: ExecutionContext, dependencies: AgentDependencies): Promise<AgentExecution> {
  let persistenceFailed = false
  try {
    const context = ExecutionContextSchema.parse(executionContext)
    const temporal = resolveTemporalReferences(query.query, { timezone: context.timezone, referenceTimestamp: context.referenceTimestamp })
    if (temporal.references.some((item) => item.kind === 'ambiguous' || item.kind === 'unspecified')) {
      return AgentExecutionSchema.parse({ status: 'needs_clarification', intent: null, temporal, history: null, searchPlan: null, answer: null, error: null })
    }
    const intent = await classifyIntent(query.query, dependencies.classifier)
    const temporalFilter = createTemporalRetrievalFilter(temporal, intent.intent, query.query) ?? undefined
    const temporalTerms = temporal.references.filter((item) => item.start !== null && item.end !== null).map((item) => item.text)
    const history: HistoricalRetrieval = await dependencies.repository.retrieve({ userId: context.userId, query: query.query, conversationId: query.conversationId, temporalFilter, temporalTerms })
    const hasHistoricalContext = history.messages.length + history.memoryItems.length + history.researchSnapshots.length > 0
    const searchPlan = createSearchPlan({ intent: intent.intent, query: query.query, hasHistoricalContext, maxCalls: dependencies.maxSearchCalls })
    if (!dependencies.reasoner || !dependencies.tavily || !dependencies.persistence) {
      return AgentExecutionSchema.parse({ status: 'planned', intent, temporal, history, searchPlan, answer: null, error: null })
    }

    const observedAt = new Date().toISOString()
    const search = await executeSearchPlan(searchPlan, dependencies.tavily, dependencies.searchLimits ?? getSearchExecutionLimits())
    const webSources = buildWebEvidence(search.results, observedAt)
    const evidenceSources = [...buildHistoricalEvidence(history), ...webSources]
    const extractedClaims = webSources.length ? await dependencies.reasoner.extractClaims(query.query, webSources) : []
    const comparisons = intent.intent === 'historical_current_comparison'
      ? compareHistoricalAndCurrent(history, extractedClaims)
      : []
    const answer = await dependencies.reasoner.generateAnswer({ query: query.query, history, sources: evidenceSources, claims: extractedClaims, comparisons })
    let persisted: { snapshotId: string; conversationId: string } | null = null
    if (searchPlan.shouldSearchWeb) {
      try {
        persisted = await dependencies.persistence.persist({ userId: context.userId, conversationId: query.conversationId, query: query.query, observedAt, searchExecution: search.execution, evidenceSources, claims: extractedClaims, comparisons })
      } catch { persistenceFailed = true; throw new Error('Research persistence failed.') }
    }
    return AgentExecutionSchema.parse({ status: 'completed', intent, temporal, history, searchPlan, searchExecution: search.execution, evidenceSources, extractedClaims, comparisons, snapshotId: persisted?.snapshotId ?? null, answer, error: null })
  } catch (error) {
    const providerError = error instanceof ProviderRequestError
    const isProvider = providerError || (error instanceof Error && /provider|gemini|tavily/i.test(error.message))
    const isRetrieval = error instanceof Error && /retrieval/i.test(error.message)
    const isPersistence = persistenceFailed || (error instanceof Error && /persistence/i.test(error.message))
    const safeError = {
      code: isProvider ? 'PROVIDER_ERROR' : isRetrieval ? 'RETRIEVAL_ERROR' : isPersistence ? 'PERSISTENCE_ERROR' : 'INTERNAL_ERROR',
      message: isProvider ? 'Research providers are temporarily unavailable.' : isRetrieval ? 'Historical context could not be retrieved.' : isPersistence ? 'Research could not be saved.' : 'Agent execution could not be completed.',
      ...(providerError && error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    } as const
    return AgentExecutionSchema.parse({ status: 'failed', intent: null, temporal: null, history: null, searchPlan: null, answer: null, error: safeError })
  }
}
