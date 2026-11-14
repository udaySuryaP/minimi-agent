import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { HistoricalRetrievalSchema, HttpUrlSchema, PublishedDateSchema, type HistoricalRetrieval, type PublishedDate, type TemporalRetrievalFilter } from './contracts'

export interface HistoricalRepository {
  retrieve(input: { userId: string; query: string; conversationId?: string; temporalFilter?: TemporalRetrievalFilter; temporalTerms?: string[] }): Promise<HistoricalRetrieval>
}

export const HISTORICAL_CANDIDATE_LIMIT = 200

type QueryResult<T> = { data: T[] | null; error: unknown }
type MessageRow = { id: string; conversation_id: string; role: 'user' | 'assistant' | 'system'; content: string; created_at: string }
type MemoryRow = { id: string; entity_name: string; content: string; valid_from: string | null; valid_to: string | null; created_at: string }
type SnapshotRow = { id: string; query: string; status: 'completed'; created_at: string; completed_at: string | null; search_params: unknown }
type ClaimRow = { id: string; snapshot_id: string; entity_name: string; claim_type: 'pricing' | 'feature' | 'announcement' | 'comparison' | 'general'; claim_text: string; claim_value: string | null; structured_data: Record<string, unknown> | null; valid_at: string | null; recorded_at: string }
type SourceRow = { id: string; claim_id: string; url: string; title: string | null; snippet: string | null; domain: string | null; score: number | null; published_at: string | null; retrieved_at: string }

function historicalClaimVerification(value: unknown): 'supported' | 'uncertain' | 'unsupported' | 'insufficient_evidence' | 'unknown' {
  if (value === 'supported' || value === 'uncertain' || value === 'unsupported' || value === 'insufficient_evidence') return value
  return 'unknown'
}

function restoredPublicationDate(searchParams: unknown, url: string, publishedAt: string | null): PublishedDate | null {
  if (searchParams && typeof searchParams === 'object' && !Array.isArray(searchParams)) {
    const values = (searchParams as Record<string, unknown>).sourcePublicationDates
    if (Array.isArray(values)) {
      const match = values.find((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).url === url)
      if (match && typeof match === 'object') {
        const parsed = PublishedDateSchema.safeParse((match as Record<string, unknown>).publishedAt)
        if (parsed.success) return parsed.data
      }
    }
  }
  return publishedAt ? { precision: 'instant', value: publishedAt } : null
}

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
    type RankedCandidate = { kind: string; id: string; rank: number }
    let rankedCandidates: RankedCandidate[] | null = null
    // The RPC applies RLS as the caller and ranks in PostgreSQL, avoiding the
    // former arbitrary 200-row recency window for ordinary text retrieval.
    if (useTextSearch && !input.temporalFilter) {
      const rpcClient = this.supabase as unknown as { rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: RankedCandidate[] | null; error: unknown }> }
      if (rpcClient.rpc) {
        const result = await rpcClient.rpc('search_historical', { p_query: searchQuery, p_conversation_id: input.conversationId ?? null, p_limit: 100 })
        if (!result.error) rankedCandidates = result.data ?? []
      }
    }
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
    let snapshotsQuery = this.supabase.from('research_snapshots').select('id, query, status, created_at, completed_at, search_params').eq('user_id', input.userId).eq('status', 'completed')
    const candidateIds = (kind: RankedCandidate['kind']) => rankedCandidates?.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.id) ?? []
    if (rankedCandidates) {
      const messageIds = candidateIds('message')
      const memoryIds = candidateIds('memory_item')
      const snapshotIds = candidateIds('research_snapshot')
      if (messageIds.length) messagesQuery = messagesQuery.in('id', messageIds)
      if (memoryIds.length) memoriesQuery = memoriesQuery.in('id', memoryIds)
      if (snapshotIds.length) snapshotsQuery = snapshotsQuery.in('id', snapshotIds)
    } else if (useTextSearch) {
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
    if (snapshotFilter) snapshotsQuery = snapshotsQuery.or(snapshotFilter.intervals.map(({ startAt, endAt }) => `and(completed_at.gte.${startAt},completed_at.lt.${endAt})`).join(','))
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
      target === 'research_snapshots' || target === 'memory_valid_time' || (rankedCandidates !== null && candidateIds('message').length === 0) ? Promise.resolve({ data: [], error: null }) : messagesQuery,
      target === 'messages' || target === 'research_snapshots' || (rankedCandidates !== null && candidateIds('memory_item').length === 0) ? Promise.resolve({ data: [], error: null }) : memoriesQuery,
      target === 'messages' || target === 'memory_valid_time' || (rankedCandidates !== null && candidateIds('research_snapshot').length === 0) ? Promise.resolve({ data: [], error: null }) : snapshotsQuery,
    ]) as unknown as [QueryResult<MessageRow>, QueryResult<MemoryRow>, QueryResult<SnapshotRow>]
    if (messages.error || memories.error || snapshots.error) throw new Error('Historical retrieval failed.')
    const snapshotIds = (snapshots.data ?? []).map((item) => item.id)
    const claimsResult = (snapshotIds.length ? await this.supabase.from('research_claims').select('id, snapshot_id, entity_name, claim_type, claim_text, claim_value, structured_data, valid_at, recorded_at').in('snapshot_id', snapshotIds).order('recorded_at', { ascending: false }).order('id', { ascending: true }).limit(40) : { data: [], error: null }) as unknown as QueryResult<ClaimRow>
    if (claimsResult.error) throw new Error('Historical retrieval failed.')
    const claims = claimsResult.data ?? []
    const claimIds = claims.map((item) => item.id)
    const sourcesResult = (claimIds.length ? await this.supabase.from('research_sources').select('id, claim_id, url, title, snippet, domain, score, published_at, retrieved_at').in('claim_id', claimIds).order('retrieved_at', { ascending: false }).order('id', { ascending: true }).limit(80) : { data: [], error: null }) as unknown as QueryResult<SourceRow>
    if (sourcesResult.error) throw new Error('Historical retrieval failed.')
    const sources = (sourcesResult.data ?? []).filter((source) => HttpUrlSchema.safeParse(source.url).success)
    return HistoricalRetrievalSchema.parse({
      messages: rankHistoricalRows(messages.data ?? [], searchText, (item) => item.content, 12).map((item) => ({ id: item.id, conversationId: item.conversation_id, role: item.role, content: item.content, createdAt: item.created_at })),
      memoryItems: rankHistoricalRows(memories.data ?? [], searchText, (item) => `${item.entity_name} ${item.content}`, 12).map((item) => ({ id: item.id, entityName: item.entity_name, content: item.content, validFrom: item.valid_from, validTo: item.valid_to, createdAt: item.created_at })),
      researchSnapshots: rankHistoricalRows(snapshots.data ?? [], searchText, (item) => item.query, 8).map((item) => ({ id: item.id, query: item.query, status: item.status, createdAt: item.created_at, claims: claims.filter((claim) => claim.snapshot_id === item.id).map((claim) => {
        const structuredData = claim.structured_data ?? {}
        return { id: claim.id, snapshotId: claim.snapshot_id, entityName: claim.entity_name, claimType: claim.claim_type, claimText: claim.claim_text, claimValue: claim.claim_value, structuredData, verificationStatus: historicalClaimVerification(structuredData.verification), provenance: 'previously_generated_claim' as const, validAt: claim.valid_at, recordedAt: claim.recorded_at, sources: sources.filter((source) => source.claim_id === claim.id).map((source) => ({ id: source.id, url: source.url, title: source.title, snippet: source.snippet, domain: source.domain, score: source.score, publishedAt: restoredPublicationDate(item.search_params, source.url, source.published_at), retrievedAt: source.retrieved_at })) }
      }) })),
    })
  }
}
