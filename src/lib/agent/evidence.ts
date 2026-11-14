import { EvidenceSourceSchema, type EvidenceSource, type HistoricalRetrieval, type PublishedDate, type ResearchClaim, type WebSearchResult } from './contracts'

function instantDate(value: string | null): PublishedDate | null {
  return value ? { precision: 'instant', value } : null
}

export function buildWebEvidence(results: WebSearchResult[], observedAt: string): EvidenceSource[] {
  const sources: EvidenceSource[] = []
  const seen = new Set<string>()
  for (const result of results) {
    for (const item of result.results) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      const url = new URL(item.url)
      sources.push(EvidenceSourceSchema.parse({
        id: `web-${sources.length + 1}`, kind: 'web', url: item.url, title: item.title, snippet: item.snippet.slice(0, 4_000),
        domain: url.hostname, publishedAt: item.publishedAt, observedAt, score: item.score, effectiveAt: null,
      }))
    }
  }
  return sources
}

export function buildHistoricalEvidence(history: HistoricalRetrieval): EvidenceSource[] {
  const sources: EvidenceSource[] = []
  for (const message of history.messages) sources.push(EvidenceSourceSchema.parse({ id: `history-message:${message.id}`, kind: 'historical_message', url: null, title: 'Historical conversation', snippet: message.content.slice(0, 4_000), domain: null, publishedAt: null, observedAt: message.createdAt, score: null, effectiveAt: null }))
  for (const memory of history.memoryItems) sources.push(EvidenceSourceSchema.parse({ id: `history-memory:${memory.id}`, kind: 'historical_memory', url: null, title: memory.entityName, snippet: memory.content.slice(0, 4_000), domain: null, publishedAt: null, observedAt: memory.createdAt, score: null, effectiveAt: instantDate(memory.validFrom) }))
  for (const snapshot of history.researchSnapshots) {
    for (const claim of snapshot.claims) {
      if (claim.sources.length === 0) sources.push(EvidenceSourceSchema.parse({ id: `history-claim:${claim.id}`, kind: 'historical_research', url: null, title: claim.entityName, snippet: claim.claimText.slice(0, 4_000), domain: null, publishedAt: null, observedAt: claim.recordedAt, score: null, effectiveAt: instantDate(claim.validAt) }))
      for (const source of claim.sources) sources.push(EvidenceSourceSchema.parse({
        id: `history-source:${source.id}`, kind: 'historical_research', url: source.url, title: source.title,
        snippet: `${claim.claimText}\n${source.snippet ?? ''}`.slice(0, 4_000), domain: new URL(source.url).hostname,
        publishedAt: source.publishedAt ? { precision: 'instant', value: source.publishedAt } : null, observedAt: source.retrievedAt,
        score: source.score, effectiveAt: instantDate(claim.validAt),
      }))
    }
  }
  return sources
}

export function historicalClaimSources(claim: ResearchClaim): string[] {
  return claim.sources.length ? claim.sources.map((source) => `history-source:${source.id}`) : [`history-claim:${claim.id}`]
}
