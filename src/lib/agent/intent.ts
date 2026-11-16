import { IntentResultSchema, type Intent, type IntentResult } from './contracts'

export interface IntentClassifier { classify(query: string): Promise<IntentResult> }

const personalMemoryQuery = (query: string): boolean => {
  const text = query.toLowerCase()
  const personalCue = /\b(?:my|i|we|our|me|remember|saved|upcoming)\b/.test(text)
  const directPlanQuestion = /\bwhat(?:'s| is| are)\s+(?:planned|scheduled|on|my upcoming)\b/.test(text)
  const memoryTopic = /\b(?:plan|planned|scheduled|schedule|meetings?|appointments?|calendar|events?)\b/.test(text)
  const personalFactQuestion = /\b(?:what(?:'s| is)|what do I|where do I|who am I|tell me about)\s+(?:my|me|I|name|live|do|location|work|job|prefer|preferences?|interests?|favorite|personal information)\b/i.test(text)
    || /\b(?:what is my name|what do i prefer|what technology do i prefer|what are my preferences)\b/i.test(text)
  return (personalCue && (memoryTopic || personalFactQuestion)) || directPlanQuestion || personalFactQuestion
}

export function classifyIntentDeterministically(query: string): IntentResult {
  const text = query.toLowerCase()
  let intent: Intent = 'general_conversational'
  if (/(compare|versus|vs\.?|compared with).*(then|before|previous|earlier|current|now|today)|(?:then|before|previous|earlier).*(?:now|today|current)|what did (?:i|we) .*\b(?:still correct|correct today|current now|today)\b/i.test(text)) intent = 'historical_current_comparison'
  else if (/(since|changed|shipped|updated).*(pricing|price|feature|launch|release)|(?:pricing|price|feature|launch|release).*(since|changed|shipped|updated)/i.test(text)) intent = 'historical_current_comparison'
  else if (/(what did (?:i|we) (?:ask|say|decide|discuss)|our conversation|in a previous chat|when did i tell you)/i.test(text)) intent = 'historical_conversation_recall'
  else if (personalMemoryQuery(text)) intent = 'historical_conversation_recall'
  else if (/(what did (?:we|you) find|what research did (?:i|we) do|previous research|last time you researched|source(?:s)? (?:you|we) found)/i.test(text)) intent = 'historical_research_recall'
  else if (/(latest|current|today|right now|research|look up|search the web|as of \d{4})/i.test(text)) intent = 'current_research'
  return IntentResultSchema.parse({ intent, confidence: intent === 'general_conversational' ? 0.55 : 0.75, rationale: 'Selected by deterministic phrase rules.' })
}

export async function classifyIntent(query: string, classifier?: IntentClassifier): Promise<IntentResult> {
  const deterministic = classifyIntentDeterministically(query)
  if (personalMemoryQuery(query)) return deterministic
  if (!classifier) return classifyIntentDeterministically(query)
  try {
    const providerResult = IntentResultSchema.parse(await classifier.classify(query))
    if (deterministic.intent !== 'general_conversational' && providerResult.intent === 'general_conversational') return deterministic
    if (deterministic.intent === 'historical_current_comparison' && providerResult.intent !== deterministic.intent) return deterministic
    return providerResult
  } catch {
    // Intent classification is an optimization. A transient classifier failure
    // must not prevent deterministic web-search routes from running.
    // Routing is an optimization. A provider outage, including rate limits,
    // must never turn a normal conversation into an HTTP 503.
    return deterministic
  }
}
