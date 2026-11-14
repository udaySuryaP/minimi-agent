import { AgentExecutionSchema, type AgentExecution } from './contracts'

export type ChatCitation = { id: string; title: string; url: string }
export type ChatMessage = { role: 'user' | 'assistant'; text: string; result?: AgentExecution }

export function parseChatResponse(payload: unknown): AgentExecution | null {
  const parsed = AgentExecutionSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

export function safeCitationUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function citationLabel(citation: ChatCitation): string {
  try {
    return new URL(citation.url).hostname.replace(/^www\./, '')
  } catch {
    return 'Source'
  }
}

export function assistantText(result: AgentExecution): string {
  return result.answer?.text || result.error?.message || 'I could not produce a source-backed answer.'
}
