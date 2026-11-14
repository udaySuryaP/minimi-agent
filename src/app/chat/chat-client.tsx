'use client'

import { FormEvent, useRef, useState } from 'react'

type Citation = { id: string; title: string; url: string }
type AgentResult = {
  status: 'needs_clarification' | 'no_search' | 'completed' | 'partial' | 'failed'
  answer: { text: string; citations: Citation[] } | null
  snapshotId: string | null
  conversationId: string | null
  error: { message: string } | null
  searchExecution: { attemptedCalls: number; completedCalls: number } | null
}
type Message = { role: 'user' | 'assistant'; text: string; result?: AgentResult }

const statusLabel: Record<AgentResult['status'], string> = {
  needs_clarification: 'Needs a little more detail',
  no_search: 'Answered from your saved context',
  completed: 'Research complete',
  partial: 'Partial result',
  failed: 'Research unavailable',
}

export default function ChatClient({ email }: { email: string | null }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [query, setQuery] = useState('')
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed || loading) return
    setMessages((current) => [...current, { role: 'user', text: trimmed }])
    setQuery('')
    setLoading(true)
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: trimmed, ...(conversationId ? { conversationId } : {}) }),
      })
      const payload = await response.json() as AgentResult | { error?: { message?: string } }
      if (!response.ok || !('status' in payload)) {
        throw new Error(('error' in payload && payload.error?.message) || 'Minimi could not complete that request.')
      }
      setConversationId(payload.conversationId ?? conversationId)
      setMessages((current) => [...current, { role: 'assistant', text: payload.answer?.text || payload.error?.message || 'I could not produce a source-backed answer.', result: payload }])
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', text: error instanceof Error ? error.message : 'Minimi could not complete that request.' }])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function reset() {
    setMessages([])
    setConversationId(undefined)
    setQuery('')
    inputRef.current?.focus()
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-500">Minimi</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Research with memory</h1>
          <p className="mt-1 text-sm text-zinc-500">Ask what changed, what was true, or what needs checking.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-zinc-500 sm:inline">{email}</span>
          <button type="button" onClick={reset} className="rounded-full border border-zinc-300 px-3 py-2 text-sm font-medium transition hover:border-indigo-400 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-400">New chat</button>
        </div>
      </header>

      <section aria-live="polite" className="flex flex-1 flex-col gap-5 py-8">
        {messages.length === 0 ? (
          <div className="m-auto max-w-xl text-center">
            <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-indigo-100 text-2xl text-indigo-600 dark:bg-indigo-950">✦</div>
            <h2 className="text-xl font-semibold">What would you like to investigate?</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500">Minimi searches current sources, compares them with saved research when relevant, and shows exactly what supports the answer.</p>
          </div>
        ) : messages.map((message, index) => (
          <article key={`${message.role}-${index}`} className={message.role === 'user' ? 'ml-auto max-w-2xl rounded-3xl rounded-br-md bg-indigo-600 px-5 py-4 text-white shadow-sm' : 'max-w-3xl rounded-3xl rounded-bl-md border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900'}>
            <p className="whitespace-pre-wrap text-sm leading-7">{message.text}</p>
            {message.result && <div className="mt-4 border-t border-current/10 pt-3 text-xs text-zinc-500">
              <p className="font-medium">{statusLabel[message.result.status]}</p>
              {message.result.searchExecution && <p className="mt-1">{message.result.searchExecution.completedCalls} of {message.result.searchExecution.attemptedCalls} source searches returned evidence.</p>}
              {message.result.answer?.citations.length ? <div className="mt-3 flex flex-wrap gap-2">{message.result.answer.citations.map((citation) => <a key={citation.id} href={citation.url} target="_blank" rel="noreferrer" className="rounded-full bg-zinc-100 px-3 py-1.5 text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-indigo-600 dark:bg-zinc-800 dark:text-zinc-300">{citation.title}</a>)}</div> : null}
            </div>}
          </article>
        ))}
        {loading && <div className="max-w-3xl rounded-3xl rounded-bl-md border border-zinc-200 bg-white px-5 py-4 text-sm text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"><span className="animate-pulse">Searching sources and checking evidence…</span></div>}
      </section>

      <form onSubmit={submit} className="sticky bottom-4 rounded-3xl border border-zinc-200 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <label htmlFor="query" className="sr-only">Ask Minimi</label>
        <div className="flex items-end gap-3">
          <textarea ref={inputRef} id="query" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(event) } }} rows={2} maxLength={4000} placeholder="Ask a research question…" disabled={loading} className="min-h-12 flex-1 resize-none rounded-2xl bg-zinc-100 px-4 py-3 text-sm outline-none ring-indigo-400 placeholder:text-zinc-400 focus:ring-2 disabled:opacity-60 dark:bg-zinc-900" />
          <button type="submit" disabled={loading || !query.trim()} className="rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50">{loading ? 'Working…' : 'Ask'}</button>
        </div>
        <p className="px-2 pt-2 text-xs text-zinc-400">Enter to send · Shift + Enter for a new line</p>
      </form>
    </main>
  )
}
