import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { HistoricalRetrievalSchema, type HistoricalRetrieval, type TemporalRetrievalFilter } from './contracts'

export interface HistoricalRepository {
  retrieve(input: { userId: string; query: string; conversationId?: string; temporalFilter?: TemporalRetrievalFilter; temporalTerms?: string[] }): Promise<HistoricalRetrieval>
}

export const HISTORICAL_CANDIDATE_LIMIT = 200

type QueryResult<T> = { data: T[] | null; error: unknown }
type MessageRow = { id: string; conversation_id: string; role: 'user' | 'assistant' | 'system'; content: string; created_at: string }
type MemoryRow = { id: string; entity_name: string; content: string; valid_from: string | null; valid_to: string | null; created_at: string }
type SnapshotRow = { id: string; query: string; status: 'pending' | 'completed' | 'failed' | 'partial'; created_at: string; completed_at: string | null }
type ClaimRow = { id: string; snapshot_id: string; entity_name: string; claim_type: 'pricing' | 'feature' | 'announcement' | 'comparison' | 'general'; claim_text: string; claim_value: string | null; structured_data: Record<string, unknown>; valid_at: string | null; recorded_at: string }
type SourceRow = { id: string; claim_id: string; url: string; title: string | null; snippet: string | null; domain: string | null; score: number | null; published_at: string | null; retrieved_at: string }

const STOP_WORDS = new Set(['a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'chat', 'conversation', 'did', 'do', 'does', 'find', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'previous', 'remember', 'say', 'the', 'their', 'them', 'then', 'there', 'this', 'to', 'us', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would', 'we', 'you', 'your', 'discuss'])

export function buildHistoricalSearchQuery(value: string): string {
  const words = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const meaningful = words.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
  const terms = (meaningful.length > 0 ? meaningful : words.filter((word) => word.length > 1)).slice(0, 6)
  return terms.join(' OR ')
}

export function rankHistoricalRows<T extends { id: string; created_at: string }>(rows: T[], query: string, content: (row: T) => string, limit: number): T[] {
  const terms = buildHistoricalSearchQuery(query).split(' OR ').map((term) => term.toLowerCase())
  return rows.map((row) => {
    const text = content(row).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    return { row, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) }
  }).sort((a, b) => b.score - a.score || b.row.created_at.localeCompare(a.row.created_at) || a.row.id.localeCompare(b.row.id)).slice(0, limit).map(({ row }) => row)
}

// Uses the authenticated server client: RLS remains active. Each query also
// includes user_id as a defense-in-depth ownership filter.
export class SupabaseHistoricalRepository implements HistoricalRepository {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async retrieve(input: { userId: string; query: string; conversationId?: string; temporalFilter?: TemporalRetrievalFilter; temporalTerms?: string[] }): Promise<HistoricalRetrieval> {
    let searchText = input.query
    for (const phrase of [...(input.temporalTerms ?? [])].sort((a, b) => b.length - a.length)) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      searchText = searchText.replace(new RegExp(escaped, 'gi'), ' ')
    }
    searchText = searchText.replace(/\s+/g, ' ').trim()
    const searchQuery = buildHistoricalSearchQuery(searchText)
    const useTextSearch = searchQuery.length > 0
    const applyInterval = <T extends { gte(column: string, value: string): T; lt(column: string, value: string): T; or(filters: string): T }>(builder: T, column: string, intervals: TemporalRetrievalFilter['intervals'], overlap = false): T => {
      if (!intervals.length) return builder
      if (!overlap && intervals.length === 1) return builder.gte(column, intervals[0].startAt).lt(column, intervals[0].endAt)
      const filters = intervals.map(({ startAt, endAt }) => overlap
        ? `and(or(valid_to.is.null,valid_to.gt.${startAt}),or(valid_from.is.null,valid_from.lt.${endAt}))`
        : `and(${column}.gte.${startAt},${column}.lt.${endAt})`).join(',')
      return builder.or(filters)
    }
    const filterFor = (kind: 'messages' | 'research_snapshots' | 'memory_valid_time') => input.temporalFilter && (input.temporalFilter.target === 'all' || input.temporalFilter.target === kind) ? input.temporalFilter : null
    let messagesQuery = this.supabase.from('messages').select('id, conversation_id, role, content, created_at').eq('user_id', input.userId)
    let memoriesQuery = this.supabase.from('memory_items').select('id, entity_name, content, valid_from, valid_to, created_at').eq('user_id', input.userId)
    let snapshotsQuery = this.supabase.from('research_snapshots').select('id, query, status, created_at, completed_at').eq('user_id', input.userId)
    if (useTextSearch) {
      messagesQuery = messagesQuery.textSearch('content', searchQuery, { type: 'websearch', config: 'english' })
      memoriesQuery = memoriesQuery.textSearch('content', searchQuery, { type: 'websearch', config: 'english' })
      snapshotsQuery = snapshotsQuery.textSearch('query', searchQuery, { type: 'websearch', config: 'english' })
    } else if (!input.temporalFilter) {
      return HistoricalRetrievalSchema.parse({ messages: [], memoryItems: [], researchSnapshots: [] })
    }
    const messageFilter = filterFor('messages')
    const memoryFilter = filterFor('memory_valid_time')
    const snapshotFilter = filterFor('research_snapshots')
    if (messageFilter) messagesQuery = applyInterval(messagesQuery, 'created_at', messageFilter.intervals)
    if (memoryFilter) memoriesQuery = applyInterval(memoriesQuery, 'valid_from', memoryFilter.intervals, true)
    if (snapshotFilter) snapshotsQuery = snapshotsQuery.or(snapshotFilter.intervals.map(({ startAt, endAt }) => `and(completed_at.gte.${startAt},completed_at.lt.${endAt}),and(completed_at.is.null,created_at.gte.${startAt},created_at.lt.${endAt})`).join(','))
    // No exposed rank projection/RPC exists in the current schema, so fetch a
    // bounded FTS candidate window before applying deterministic local ranking.
    const candidateEnd = HISTORICAL_CANDIDATE_LIMIT - 1
    messagesQuery = messagesQuery.order('created_at', { ascending: false }).order('id', { ascending: true }).range(0, candidateEnd)
    memoriesQuery = memoriesQuery.order('created_at', { ascending: false }).order('id', { ascending: true }).range(0, candidateEnd)
    snapshotsQuery = snapshotsQuery.order('created_at', { ascending: false }).order('id', { ascending: true }).range(0, candidateEnd)
    if (input.conversationId) {
      messagesQuery = messagesQuery.eq('conversation_id', input.conversationId)
      memoriesQuery = memoriesQuery.eq('conversation_id', input.conversationId)
      snapshotsQuery = snapshotsQuery.eq('conversation_id', input.conversationId)
    }
    const target = input.temporalFilter?.target
    const [messages, memories, snapshots] = await Promise.all([
      target === 'research_snapshots' || target === 'memory_valid_time' ? Promise.resolve({ data: [], error: null }) : messagesQuery,
      target === 'messages' || target === 'research_snapshots' ? Promise.resolve({ data: [], error: null }) : memoriesQuery,
      target === 'messages' || target === 'memory_valid_time' ? Promise.resolve({ data: [], error: null }) : snapshotsQuery,
    ]) as unknown as [QueryResult<MessageRow>, QueryResult<MemoryRow>, QueryResult<SnapshotRow>]
    if (messages.error || memories.error || snapshots.error) throw new Error('Historical retrieval failed.')
    const snapshotIds = (snapshots.data ?? []).map((item) => item.id)
    const claimsResult = (snapshotIds.length ? await this.supabase.from('research_claims').select('id, snapshot_id, entity_name, claim_type, claim_text, claim_value, structured_data, valid_at, recorded_at').in('snapshot_id', snapshotIds).order('recorded_at', { ascending: false }).order('id', { ascending: true }).limit(40) : { data: [], error: null }) as unknown as QueryResult<ClaimRow>
    if (claimsResult.error) throw new Error('Historical retrieval failed.')
    const claims = claimsResult.data ?? []
    const claimIds = claims.map((item) => item.id)
    const sourcesResult = (claimIds.length ? await this.supabase.from('research_sources').select('id, claim_id, url, title, snippet, domain, score, published_at, retrieved_at').in('claim_id', claimIds).order('retrieved_at', { ascending: false }).order('id', { ascending: true }).limit(80) : { data: [], error: null }) as unknown as QueryResult<SourceRow>
    if (sourcesResult.error) throw new Error('Historical retrieval failed.')
    const sources = sourcesResult.data ?? []
    return HistoricalRetrievalSchema.parse({
      messages: rankHistoricalRows(messages.data ?? [], searchText, (item) => item.content, 12).map((item) => ({ id: item.id, conversationId: item.conversation_id, role: item.role, content: item.content, createdAt: item.created_at })),
      memoryItems: rankHistoricalRows(memories.data ?? [], searchText, (item) => `${item.entity_name} ${item.content}`, 12).map((item) => ({ id: item.id, entityName: item.entity_name, content: item.content, validFrom: item.valid_from, validTo: item.valid_to, createdAt: item.created_at })),
      researchSnapshots: rankHistoricalRows(snapshots.data ?? [], searchText, (item) => item.query, 8).map((item) => ({ id: item.id, query: item.query, status: item.status, createdAt: item.created_at, claims: claims.filter((claim) => claim.snapshot_id === item.id).map((claim) => ({ id: claim.id, snapshotId: claim.snapshot_id, entityName: claim.entity_name, claimType: claim.claim_type, claimText: claim.claim_text, claimValue: claim.claim_value, structuredData: claim.structured_data, validAt: claim.valid_at, recordedAt: claim.recorded_at, sources: sources.filter((source) => source.claim_id === claim.id).map((source) => ({ id: source.id, url: source.url, title: source.title, snippet: source.snippet, domain: source.domain, score: source.score, publishedAt: source.published_at, retrievedAt: source.retrieved_at })) })) })),
    })
  }
}
