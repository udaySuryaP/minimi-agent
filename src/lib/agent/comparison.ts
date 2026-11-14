import { ClaimComparisonResultSchema, type ClaimComparisonResult, type ExtractedResearchClaim, type HistoricalRetrieval } from './contracts'
import { historicalClaimSources } from './evidence'

type HistoricalFact = {
  entityName: string; claimType: ExtractedResearchClaim['claimType']; claimText: string; claimValue: string | null;
  currency: string | null; billingPeriod: string | null; region: string | null; planOrVersion: string | null; sourceIds: string[]
}

function historicalFacts(history: HistoricalRetrieval): HistoricalFact[] {
  const research = history.researchSnapshots.flatMap((snapshot) => snapshot.claims.map((claim) => ({
    entityName: claim.entityName, claimType: claim.claimType, claimText: claim.claimText, claimValue: claim.claimValue,
    currency: typeof claim.structuredData.currency === 'string' ? claim.structuredData.currency : null,
    billingPeriod: typeof claim.structuredData.billingPeriod === 'string' ? claim.structuredData.billingPeriod : null,
    region: typeof claim.structuredData.region === 'string' ? claim.structuredData.region : null,
    planOrVersion: typeof claim.structuredData.planOrVersion === 'string' ? claim.structuredData.planOrVersion : null,
    sourceIds: historicalClaimSources(claim),
  })))
  const memories = history.memoryItems.map((item) => ({ entityName: item.entityName, claimType: 'general' as const, claimText: item.content, claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, sourceIds: [`history-memory:${item.id}`] }))
  return [...research, ...memories]
}

function key(value: string): string { return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }
function numberValue(value: string | null): number | null {
  if (!value) return null
  const normalized = value.replace(/[,\s]/g, '')
  return /^-?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null
}

function comparePair(oldFact: HistoricalFact, current: ExtractedResearchClaim): ClaimComparisonResult {
  const sourceIds = [...new Set([...oldFact.sourceIds, ...current.sourceIds])]
  if (current.claimType === 'pricing') {
    const dimensions = ['currency', 'billingPeriod', 'region', 'planOrVersion'] as const
    if (dimensions.some((dimension) => key(oldFact[dimension] ?? '') !== key(current[dimension] ?? ''))) {
      return ClaimComparisonResultSchema.parse({ historicalClaim: oldFact.claimText, currentClaim: current.claimText, outcome: 'insufficient_evidence', explanation: 'The price records do not establish the same currency, billing period, region, plan, and version.', sourceIds })
    }
    const before = numberValue(oldFact.claimValue)
    const after = numberValue(current.claimValue)
    if (before === null || after === null) return ClaimComparisonResultSchema.parse({ historicalClaim: oldFact.claimText, currentClaim: current.claimText, outcome: 'insufficient_evidence', explanation: 'Comparable numeric price values were not available.', sourceIds })
    return ClaimComparisonResultSchema.parse({ historicalClaim: oldFact.claimText, currentClaim: current.claimText, outcome: before === after ? 'unchanged' : 'changed', explanation: before === after ? 'The comparable price values match.' : 'The comparable price values differ for the same stated dimensions.', sourceIds })
  }
  const unchanged = key(oldFact.claimText) === key(current.claimText)
  return ClaimComparisonResultSchema.parse({ historicalClaim: oldFact.claimText, currentClaim: current.claimText, outcome: unchanged ? 'unchanged' : 'conflicting', explanation: unchanged ? 'The normalized claim text matches.' : 'The historical and current claims differ; this does not establish which one is correct.', sourceIds })
}

export function compareHistoricalAndCurrent(history: HistoricalRetrieval, currentClaims: ExtractedResearchClaim[]): ClaimComparisonResult[] {
  const oldFacts = historicalFacts(history)
  if (oldFacts.length === 0 && currentClaims.length === 0) return [ClaimComparisonResultSchema.parse({ historicalClaim: null, currentClaim: null, outcome: 'insufficient_evidence', explanation: 'No comparable historical or current claims were retrieved.', sourceIds: [] })]
  const results: ClaimComparisonResult[] = []
  const matchedOld = new Set<number>()
  for (const current of currentClaims) {
    const matching = oldFacts.map((fact, index) => ({ fact, index })).filter(({ fact }) => key(fact.entityName) === key(current.entityName) && fact.claimType === current.claimType)
    if (matching.length === 0) {
      results.push(ClaimComparisonResultSchema.parse({ historicalClaim: null, currentClaim: current.claimText, outcome: oldFacts.length ? 'new_information' : 'insufficient_evidence', explanation: oldFacts.length ? 'No matching historical claim was found; absence from history does not prove the information is new.' : 'No historical claim was available for comparison.', sourceIds: current.sourceIds }))
    } else {
      for (const { fact, index } of matching) {
        matchedOld.add(index)
        results.push(comparePair(fact, current))
      }
    }
  }
  oldFacts.forEach((fact, index) => {
    if (!matchedOld.has(index)) results.push(ClaimComparisonResultSchema.parse({ historicalClaim: fact.claimText, currentClaim: null, outcome: 'historical_unverified', explanation: 'No current claim with a matching entity and type was retrieved; the historical claim could not be reverified.', sourceIds: fact.sourceIds }))
  })
  for (let left = 0; left < currentClaims.length; left += 1) for (let right = left + 1; right < currentClaims.length; right += 1) {
    const a = currentClaims[left]
    const b = currentClaims[right]
    if (key(a.entityName) === key(b.entityName) && a.claimType === b.claimType && key(a.claimText) !== key(b.claimText)) {
      results.push(ClaimComparisonResultSchema.parse({ historicalClaim: null, currentClaim: `${a.claimText} / ${b.claimText}`, outcome: 'conflicting', explanation: 'Current sources supplied differing claims for the same entity and type.', sourceIds: [...new Set([...a.sourceIds, ...b.sourceIds])] }))
    }
  }
  return results.length ? results : [ClaimComparisonResultSchema.parse({ historicalClaim: null, currentClaim: null, outcome: 'insufficient_evidence', explanation: 'The retrieved evidence did not support a comparison.', sourceIds: [] })]
}
