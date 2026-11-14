import { IntentResultSchema, type Intent, type IntentResult } from './contracts'
import { ProviderRequestError } from './provider-errors'

export interface IntentClassifier { classify(query: string): Promise<IntentResult> }

export function classifyIntentDeterministically(query: string): IntentResult {
  const text = query.toLowerCase()
  let intent: Intent = 'general_conversational'
  if (/(compare|versus|vs\.?|compared with).*(then|before|previous|earlier|current|now|today)|(?:then|before|previous|earlier).*(?:now|today|current)/i.test(text)) intent = 'historical_current_comparison'
  else if (/(what did (?:i|we) (?:say|decide|discuss)|our conversation|in a previous chat|when did i tell you)/i.test(text)) intent = 'historical_conversation_recall'
  else if (/(what did (?:we|you) find|what research did (?:i|we) do|previous research|last time you researched|source(?:s)? (?:you|we) found)/i.test(text)) intent = 'historical_research_recall'
  else if (/(latest|current|today|right now|research|look up|search the web|as of \d{4})/i.test(text)) intent = 'current_research'
  return IntentResultSchema.parse({ intent, confidence: intent === 'general_conversational' ? 0.55 : 0.75, rationale: 'Selected by deterministic phrase rules.' })
}

export async function classifyIntent(query: string, classifier?: IntentClassifier): Promise<IntentResult> {
  if (!classifier) return classifyIntentDeterministically(query)
  try {
    return IntentResultSchema.parse(await classifier.classify(query))
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error
    throw new ProviderRequestError('request_failed')
  }
}
