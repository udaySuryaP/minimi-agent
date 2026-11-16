import { z } from 'zod'
import type { RememberedMemory } from './memory'

export const ModelDecisionSchema = z.object({
  action: z.enum(['capture', 'personal', 'web', 'reject']),
  memories: z.array(z.object({
    entityType: z.enum(['fact', 'preference', 'decision', 'topic', 'product', 'company', 'other']),
    entityName: z.string().trim().min(1).max(120),
    content: z.string().trim().min(1).max(500),
    validFrom: z.string().nullable().optional(),
    validTo: z.string().nullable().optional(),
  }).strict()).max(20),
  rationale: z.string().trim().max(300),
}).strict()

export type ModelDecision = z.infer<typeof ModelDecisionSchema>

const PROMPT = [
  'You are Minimi’s request router and personal-memory extractor.',
  'Classify the user message into exactly one action: capture, personal, web, or reject.',
  'capture means the user is stating personal information, preference, plan, decision, project context, or future intention to remember.',
  'personal means the user asks for information about themselves or their saved context.',
  'web means the user asks for current, external, source-backed, or up-to-date information.',
  'reject means ordinary opinion, unsupported conversation, ambiguity, or a request that is neither personal nor current web research.',
  'For capture, extract every independent fact and preserve the user meaning. Never extract secrets, passwords, API keys, OTPs, or credentials.',
  'For all other actions, memories must be an empty array.',
  'Return only the specified JSON object. Do not answer the user.',
].join(' ')

function modelConfig(): { provider: 'openrouter' | 'gemini'; key: string; model: string } | null {
  if (process.env.OPENROUTER_API_KEY) {
    const model = process.env.OPENROUTER_ROUTER_MODEL || process.env.OPENROUTER_MODEL || process.env.OPENROUTER_MEMORY_MODEL
    if (model) return { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY, model }
  }
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_ROUTER_MODEL || 'gemini-2.5-flash' }
  return null
}

function parseJson(value: unknown): unknown {
  const content = (value as { choices?: Array<{ message?: { content?: unknown } }>; candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })?.choices?.[0]?.message?.content
    ?? (value as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof content !== 'string') throw new Error('Malformed router response.')
  return JSON.parse(content)
}

export async function analyzeUserMessage(query: string, memoryMiss = false): Promise<ModelDecision | null> {
  const config = modelConfig()
  if (!config) return null
  const timeout = Math.min(10_000, Math.max(2_000, Number(process.env.OPENROUTER_ROUTER_TIMEOUT_MS) || 6_000))
  try {
    const routingPrompt = memoryMiss
      ? `${PROMPT} Personal memory retrieval returned no matching vector records. In this fallback pass, choose web only if the question can be answered with current external sources; otherwise choose reject.`
      : PROMPT
    const jsonSchema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['capture', 'personal', 'web', 'reject'] },
        memories: { type: 'array', items: { type: 'object', properties: {
          entityType: { type: 'string', enum: ['fact', 'preference', 'decision', 'topic', 'product', 'company', 'other'] },
          entityName: { type: 'string' }, content: { type: 'string' },
          validFrom: { type: ['string', 'null'] }, validTo: { type: ['string', 'null'] },
        }, required: ['entityType', 'entityName', 'content', 'validFrom', 'validTo'], additionalProperties: false } },
        rationale: { type: 'string' },
      }, required: ['action', 'memories', 'rationale'], additionalProperties: false,
    }
    const request: { url: string; headers: Record<string, string>; body: unknown } = config.provider === 'openrouter'
      ? { url: 'https://openrouter.ai/api/v1/chat/completions', headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' }, body: { model: config.model, max_tokens: 600, temperature: 0, messages: [{ role: 'system', content: routingPrompt }, { role: 'user', content: query.slice(0, 4000) }], response_format: { type: 'json_schema', json_schema: { name: 'minimi_request_decision', strict: true, schema: jsonSchema } } } }
      : { url: `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, headers: { 'x-goog-api-key': config.key, 'content-type': 'application/json' }, body: { systemInstruction: { parts: [{ text: routingPrompt }] }, contents: [{ parts: [{ text: query.slice(0, 4000) }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: jsonSchema } } }
    const response = await fetch(request.url, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: request.headers, body: JSON.stringify(request.body) })
    if (!response.ok) return null
    const parsed = ModelDecisionSchema.safeParse(parseJson(await response.json()))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

export function modelMemoriesOrFallback(decision: ModelDecision | null, fallback: RememberedMemory[]): RememberedMemory[] {
  return decision?.action === 'capture' && decision.memories.length ? decision.memories : fallback
}
