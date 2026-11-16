import { AgentExecutionSchema, ExecutionContextSchema, type AgentExecution, type AgentQuery, type ExecutionContext, type HistoricalRetrieval } from './contracts'
import { classifyIntent, classifyIntentDeterministically, type IntentClassifier } from './intent'
import { createTemporalRetrievalFilter, resolveTemporalReferences } from './temporal'
import { createSearchPlan } from './search-plan'
import type { HistoricalRepository } from './retrieval'
import { ProviderRequestError } from './provider-errors'
import type { ResearchReasoner, TavilyProvider } from './providers'
import { getSearchExecutionLimits, type SearchExecutionLimits } from './search-executor'
import { buildHistoricalEvidence, buildWebEvidence } from './evidence'
import type { ResearchPersistenceRepository } from './persistence'
import { buildDeterministicMemoryAcknowledgement, buildMemoryAcknowledgement, isPersonalMemoryRecall } from './memory'
import { buildEntityAwareSearchQueries } from './query-planner'
import { classifyPersonalQuery } from './memory-rag'
import { PersonalMemoryService, type MemoryService } from './memory-service'
import { decideRequestLane } from './request-router'
import { TavilyResearchService } from './research-service'
import type { ModelDecision } from './model-decision'
import { BaselineComparisonService, type ComparisonService } from './comparison-service'
import { EvidenceResponseComposer, type ResponseComposer } from './response-composer'
import type { ConversationLedger } from './conversation-ledger'

export interface AgentDependencies {
  classifier?: IntentClassifier
  repository: HistoricalRepository
  maxSearchCalls?: number
  reasoner?: ResearchReasoner
  tavily?: TavilyProvider
  persistence?: ResearchPersistenceRepository
  searchLimits?: SearchExecutionLimits
  planSearch?: typeof createSearchPlan
  memory?: MemoryService
  modelDecision?: ModelDecision | null
  comparison?: ComparisonService
  responses?: ResponseComposer
  ledger?: ConversationLedger
}

type AgentErrorCode = NonNullable<AgentExecution['error']>['code']
const errorValue = (code: AgentErrorCode, message: string, details: { cleanupAttempted?: boolean; cleanupSucceeded?: boolean } = {}) => ({ code, message, ...details })
const safeRejection = { text: 'I don’t have a reliable source-based answer for that.', citations: [], claims: [] } as const
export async function executeAgent(query: AgentQuery, executionContext: ExecutionContext, dependencies: AgentDependencies): Promise<AgentExecution> {
  let persistenceFailed = false
  let persistenceCleanupAttempted: boolean | undefined
  let persistenceCleanupSucceeded: boolean | undefined
  try {
    const context = ExecutionContextSchema.parse(executionContext)
    const temporal = resolveTemporalReferences(query.query, { timezone: context.timezone, referenceTimestamp: context.referenceTimestamp })
    if (temporal.references.some((item) => item.kind === 'ambiguous' || item.kind === 'unspecified')) {
      return AgentExecutionSchema.parse({ status: 'needs_clarification', intent: null, temporal, history: null, searchPlan: null, answer: null, error: null })
    }
    const memory = dependencies.memory ?? new PersonalMemoryService(dependencies.repository)
    const comparison = dependencies.comparison ?? new BaselineComparisonService()
    const responses = dependencies.responses ?? new EvidenceResponseComposer()
    let modelDecision = dependencies.modelDecision ?? await memory.analyze(query.query)
    const explicitMemory = modelDecision?.action === 'capture'
      ? buildMemoryAcknowledgement(modelDecision.memories)
      : buildDeterministicMemoryAcknowledgement(query.query)
    if (explicitMemory) {
      const intent = classifyIntentDeterministically(query.query)
      const searchLimits = dependencies.searchLimits ?? getSearchExecutionLimits()
      const searchPlan = (dependencies.planSearch ?? createSearchPlan)({ intent: intent.intent, query: query.query, hasHistoricalContext: false, maxCalls: Math.min(dependencies.maxSearchCalls ?? searchLimits.maxCalls, searchLimits.maxCalls) })
      const emptyHistory: HistoricalRetrieval = { messages: [], memoryItems: [], researchSnapshots: [] }
      return AgentExecutionSchema.parse({ status: 'no_search', intent, temporal, history: emptyHistory, searchPlan, evidenceSources: [], answer: explicitMemory, error: null })
    }
    if (modelDecision?.action === 'reject') {
      const intent = classifyIntentDeterministically(query.query)
      const emptyHistory: HistoricalRetrieval = { messages: [], memoryItems: [], researchSnapshots: [] }
      return AgentExecutionSchema.parse({ status: 'no_search', intent, temporal, history: emptyHistory, searchPlan: null, evidenceSources: [], answer: responses.rejection(), error: null })
    }
    const intent = await classifyIntent(query.query, dependencies.classifier)
    const temporalFilter = createTemporalRetrievalFilter(temporal, intent.intent, query.query) ?? undefined
    const temporalTerms = temporal.references.filter((item) => item.start !== null && item.end !== null).map((item) => item.text)
    const history: HistoricalRetrieval = await (dependencies.ledger ?? memory).retrieve({ userId: context.userId, query: query.query, conversationId: query.conversationId, temporalFilter, temporalTerms })
    if (modelDecision?.action === 'personal' && !history.memoryItems.length && !history.messages.length) {
      const fallbackDecision = await memory.analyze(query.query, true)
      modelDecision = fallbackDecision?.action === 'web' || fallbackDecision?.action === 'reject' ? fallbackDecision : { ...modelDecision, action: 'reject' }
    }
    if (modelDecision?.action === 'reject' || (modelDecision?.action === 'capture' && !modelDecision.memories.length)) {
      return AgentExecutionSchema.parse({ status: 'no_search', intent, temporal, history, searchPlan: null, evidenceSources: [], answer: responses.rejection(), error: null })
    }
    const answerHistory: HistoricalRetrieval = (intent.intent === 'general_conversational' && !isPersonalMemoryRecall(query.query))
      ? { messages: [], memoryItems: [], researchSnapshots: [] }
      : history
    // This small model classifies the conversational lane for personal RAG;
    // the existing search plan remains authoritative for Tavily execution.
    const memoryRoute = modelDecision ? null : await classifyPersonalQuery(query.query)
    const decision = modelDecision
      ? { lane: modelDecision.action === 'personal' ? 'personal' as const : modelDecision.action === 'web' ? 'web' as const : 'conversation' as const, reason: 'Model decision selected the request lane.', needsMemoryFallback: modelDecision.action === 'personal' }
      : decideRequestLane(query.query, intent, memoryRoute)
    // If personal retrieval misses and the route model explicitly identifies a
    // web request, promote this turn to current research. This is the only
    // fallback from the memory lane into Tavily.
    const effectiveIntent = decision.lane === 'web' && intent.intent !== 'current_research' && intent.intent !== 'historical_current_comparison'
      ? { ...intent, intent: 'current_research' as const, rationale: `${intent.rationale} Fallback web route selected.` }
      : intent
    const hasHistoricalContext = history.messages.length + history.memoryItems.length + history.researchSnapshots.length > 0
    const searchLimits = dependencies.searchLimits ?? getSearchExecutionLimits()
    const searchPlan = (dependencies.planSearch ?? createSearchPlan)({ intent: effectiveIntent.intent, query: query.query, hasHistoricalContext, maxCalls: Math.min(dependencies.maxSearchCalls ?? searchLimits.maxCalls, searchLimits.maxCalls), searchQueries: buildEntityAwareSearchQueries(query.query, history) })

    // A conversational or memory-only question only needs a reasoning provider
    // or the optional bounded personal-memory RAG lane.
    // Requiring web search and snapshot persistence here made ordinary questions
    // fail whenever Tavily was unavailable, even though no web call was planned.
    if (!dependencies.reasoner && !searchPlan.shouldSearchWeb) {
      // A new explicit note is an action, not a recall question. Acknowledge it
      // before looking at older memory so a fresh meeting/date cannot be
      // answered with a stale saved item.
      const memoryAnswer = buildDeterministicMemoryAcknowledgement(query.query)
        ?? await memory.answer(query.query, answerHistory, memoryRoute ?? undefined)
      if (memoryAnswer) {
        const evidenceSources = buildHistoricalEvidence(answerHistory)
        return AgentExecutionSchema.parse({ status: 'no_search', intent, temporal, history, searchPlan, evidenceSources, answer: memoryAnswer, error: null })
      }
      return AgentExecutionSchema.parse({ status: 'no_search', intent, temporal, history, searchPlan, answer: responses.rejection(), error: errorValue('PROVIDER_ERROR', 'No answer model is configured for this request.') })
    }

    if (searchPlan.shouldSearchWeb && !dependencies.tavily) {
      return AgentExecutionSchema.parse({ status: 'failed', intent, temporal, history, searchPlan, answer: responses.rejection(), error: errorValue('PROVIDER_ERROR', 'Web search is not configured.') })
    }

    if (!searchPlan.shouldSearchWeb) {
      const evidenceSources = buildHistoricalEvidence(answerHistory)
      const answer = buildDeterministicMemoryAcknowledgement(query.query)
        ?? await memory.answer(query.query, answerHistory, memoryRoute ?? undefined)
        ?? await dependencies.reasoner!.generateAnswer({ query: query.query, history: answerHistory, sources: evidenceSources, claims: [], comparisons: [] })
      return AgentExecutionSchema.parse({ status: 'no_search', intent, temporal, history, searchPlan, evidenceSources, answer, error: null })
    }

    const observedAt = new Date().toISOString()
    const search = await new TavilyResearchService(dependencies.tavily!).search(searchPlan, searchLimits)
    const successes = search.execution.outcomes.filter((outcome) => outcome.status === 'succeeded').length
    const failures = search.execution.outcomes.filter((outcome) => outcome.status === 'failed').length
    const persist = async (claims: Parameters<ResearchPersistenceRepository['persist']>[0]['claims'], comparisons: Parameters<ResearchPersistenceRepository['persist']>[0]['comparisons'], evidenceSources: Parameters<ResearchPersistenceRepository['persist']>[0]['evidenceSources'], status?: 'completed' | 'failed' | 'partial') => {
      try {
        return await dependencies.persistence!.persist({ userId: context.userId, conversationId: query.conversationId, query: query.query, observedAt, searchExecution: search.execution, evidenceSources, claims, comparisons, status })
      } catch (error) {
        persistenceFailed = true
        if (error instanceof Error && 'cleanupAttempted' in error && typeof error.cleanupAttempted === 'boolean') persistenceCleanupAttempted = error.cleanupAttempted
        if (error instanceof Error && 'cleanupSucceeded' in error && typeof error.cleanupSucceeded === 'boolean') persistenceCleanupSucceeded = error.cleanupSucceeded
        return null
      }
    }
    const base = { intent, temporal, history, searchPlan, searchExecution: search.execution }
    if (search.execution.attemptedCalls === 0 || successes === 0) {
      const persisted = await persist([], [], [])
      return AgentExecutionSchema.parse({ status: 'failed', ...base, evidenceSources: [], extractedClaims: [], comparisons: [], snapshotId: persisted?.snapshotId ?? null, answer: responses.rejection(), error: errorValue(persistenceFailed ? 'PERSISTENCE_ERROR' : 'PROVIDER_ERROR', persistenceFailed ? 'Research could not be saved.' : 'All planned web searches failed.', { cleanupAttempted: persistenceCleanupAttempted, cleanupSucceeded: persistenceCleanupSucceeded }) })
    }

    const webSources = buildWebEvidence(search.results, observedAt)
    const evidenceSources = [...buildHistoricalEvidence(history), ...webSources]
    let extractedClaims: Awaited<ReturnType<ResearchReasoner['extractClaims']>> = []
    if (!dependencies.reasoner) {
      const persisted = await persist([], [], evidenceSources, failures > 0 ? 'partial' : 'completed')
      const state = failures > 0 ? 'partial' : 'completed'
      return AgentExecutionSchema.parse({ status: state, ...base, evidenceSources, extractedClaims: [], comparisons: [], snapshotId: persisted?.snapshotId ?? null, conversationId: persisted?.conversationId ?? null, answer: responses.rejection(), error: errorValue('PROVIDER_ERROR', 'Search evidence could not be synthesized safely.') })
    }
    try {
      extractedClaims = webSources.length ? await dependencies.reasoner.extractClaims(query.query, webSources) : []
    } catch {
      const persisted = await persist([], [], evidenceSources, 'partial')
      return AgentExecutionSchema.parse({ status: 'partial', ...base, evidenceSources, extractedClaims: [], comparisons: [], snapshotId: persisted?.snapshotId ?? null, conversationId: persisted?.conversationId ?? null, answer: responses.rejection(), error: persistenceFailed ? errorValue('PERSISTENCE_ERROR', 'Search evidence was found but could not be saved.', { cleanupAttempted: persistenceCleanupAttempted, cleanupSucceeded: persistenceCleanupSucceeded }) : errorValue('PROVIDER_ERROR', 'Search evidence could not be synthesized safely.') })
    }
    const comparisons = intent.intent === 'historical_current_comparison' ? comparison.compare(history, extractedClaims) : []
    const deterministicComparison = intent.intent === 'historical_current_comparison'
      ? comparison.compose(comparisons, evidenceSources)
      : null
    if (deterministicComparison) {
      const persisted = await persist(extractedClaims, comparisons, evidenceSources, failures > 0 ? 'partial' : 'completed')
      const state = persistenceFailed || failures > 0 ? 'partial' : 'completed'
      return AgentExecutionSchema.parse({ status: state, ...base, evidenceSources, extractedClaims, comparisons, snapshotId: persisted?.snapshotId ?? null, conversationId: persisted?.conversationId ?? null, answer: deterministicComparison,
        error: persistenceFailed ? errorValue('PERSISTENCE_ERROR', 'Research results were generated but could not be saved.', { cleanupAttempted: persistenceCleanupAttempted, cleanupSucceeded: persistenceCleanupSucceeded }) : failures > 0 ? errorValue('PROVIDER_ERROR', 'Some planned web searches failed; this answer may be incomplete.') : null })
    }
    let answer: Awaited<ReturnType<ResearchReasoner['generateAnswer']>>
    try {
      answer = await dependencies.reasoner.generateAnswer({ query: query.query, history: answerHistory, sources: evidenceSources, claims: extractedClaims, comparisons })
    } catch {
      const persisted = await persist(extractedClaims, comparisons, evidenceSources, 'partial')
      return AgentExecutionSchema.parse({ status: 'partial', ...base, evidenceSources, extractedClaims, comparisons, snapshotId: persisted?.snapshotId ?? null, conversationId: persisted?.conversationId ?? null, answer: responses.rejection(), error: persistenceFailed ? errorValue('PERSISTENCE_ERROR', 'Research findings were generated but could not be saved.', { cleanupAttempted: persistenceCleanupAttempted, cleanupSucceeded: persistenceCleanupSucceeded }) : errorValue('PROVIDER_ERROR', 'Research findings could not be synthesized safely.') })
    }
    const persisted = await persist(extractedClaims, comparisons, evidenceSources, failures > 0 ? 'partial' : 'completed')
    const state = persistenceFailed || failures > 0 ? 'partial' : 'completed'
    return AgentExecutionSchema.parse({ status: state, ...base, evidenceSources, extractedClaims, comparisons, snapshotId: persisted?.snapshotId ?? null, conversationId: persisted?.conversationId ?? null, answer,
      error: persistenceFailed ? errorValue('PERSISTENCE_ERROR', 'Research results were generated but could not be saved.', { cleanupAttempted: persistenceCleanupAttempted, cleanupSucceeded: persistenceCleanupSucceeded }) : failures > 0 ? errorValue('PROVIDER_ERROR', 'Some planned web searches failed; this answer may be incomplete.') : null })
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
    return AgentExecutionSchema.parse({ status: 'failed', intent: null, temporal: null, history: null, searchPlan: null, answer: safeRejection, error: safeError })
  }
}
