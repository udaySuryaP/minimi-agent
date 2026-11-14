import { SearchPlanSchema, type Intent, type SearchPlan } from './contracts'

export const DEFAULT_MAX_TAVILY_CALLS = 8
export function createSearchPlan(input: { intent: Intent; query: string; hasHistoricalContext: boolean; maxCalls?: number }): SearchPlan {
  const maxCalls = Math.min(DEFAULT_MAX_TAVILY_CALLS, Math.max(0, Math.floor(input.maxCalls ?? DEFAULT_MAX_TAVILY_CALLS)))
  const historicalIntent = input.intent === 'historical_conversation_recall' || input.intent === 'historical_research_recall' || input.intent === 'historical_current_comparison'
  const needsCurrent = input.intent === 'current_research' || input.intent === 'historical_current_comparison'
  const currentQuestions = needsCurrent ? [input.query.trim()] : []
  const missing = historicalIntent && !input.hasHistoricalContext ? ['No matching historical records were retrieved.'] : []
  const shouldSearchWeb = needsCurrent && maxCalls > 0
  const stopReason = shouldSearchWeb ? `Current research will execute with a maximum of ${maxCalls} bounded call(s).` : needsCurrent ? 'Web search is disabled by the configured call limit.' : 'This intent does not require current web evidence.'
  return SearchPlanSchema.parse({ shouldSearchWeb, historicalInformationMissing: missing, currentQuestions, maxCalls: shouldSearchWeb ? maxCalls : 0, stopReason })
}
