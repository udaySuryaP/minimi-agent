import { ClaimComparisonResultSchema, type ClaimComparisonResult, type ExtractedResearchClaim, type HistoricalRetrieval } from './contracts'
import { historicalClaimSources } from './evidence'

type HistoricalFact = {
  entityName: string; claimType: ExtractedResearchClaim['claimType']; proposition: string | null; claimText: string; claimValue: string | null
  currency: string | null; billingPeriod: string | null; region: string | null; planOrVersion: string | null
  priceType: ExtractedResearchClaim['priceType']; discountConditions: string | null; verificationStatus: HistoricalRetrieval['researchSnapshots'][number]['claims'][number]['verificationStatus']; sourceIds: string[]
}

const normalize = (value: string | null | undefined): string => (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const distinct = (values: string[]): string[] => [...new Set(values)]

function historicalFacts(history: HistoricalRetrieval): HistoricalFact[] {
  const research = history.researchSnapshots.flatMap((snapshot) => snapshot.claims.map((claim) => {
    const data = claim.structuredData
    const stringOrNull = (key: string): string | null => typeof data[key] === 'string' ? data[key] as string : null
    const priceType: HistoricalFact['priceType'] = data.priceType === 'standard' || data.priceType === 'promotional' ? data.priceType : 'unknown'
    return {
      entityName: claim.entityName, claimType: claim.claimType, proposition: stringOrNull('proposition'), claimText: claim.claimText, claimValue: claim.claimValue,
      currency: stringOrNull('currency'), billingPeriod: stringOrNull('billingPeriod'), region: stringOrNull('region'), planOrVersion: stringOrNull('planOrVersion'),
      priceType, discountConditions: stringOrNull('discountConditions'), verificationStatus: claim.verificationStatus, sourceIds: historicalClaimSources(claim),
    }
  }))
  const memories = history.memoryItems.map((item) => ({ entityName: item.entityName, claimType: 'general' as const, proposition: null, claimText: item.content, claimValue: null, currency: null, billingPeriod: null, region: null, planOrVersion: null, priceType: 'unknown' as const, discountConditions: null, verificationStatus: 'unknown' as const, sourceIds: [`history-memory:${item.id}`] }))
  return [...research, ...memories]
}

function result(historicalClaim: string | null, currentClaim: string | null, outcome: ClaimComparisonResult['outcome'], explanation: string, sourceIds: string[]): ClaimComparisonResult {
  return ClaimComparisonResultSchema.parse({ historicalClaim, currentClaim, outcome, explanation, sourceIds: distinct(sourceIds) })
}

function numberValue(value: string | null): number | null {
  if (!value) return null
  const normalized = value.replace(/[,$\s]/g, '')
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function isComparablePriceType(value: unknown): value is 'standard' | 'promotional' {
  return value === 'standard' || value === 'promotional'
}

function polarity(value: string | null): boolean | null {
  const normalized = normalize(value)
  if (['supported', 'supports', 'available', 'enabled', 'included', 'true', 'yes'].includes(normalized)) return true
  if (['unsupported', 'does not support', 'unavailable', 'disabled', 'not included', 'false', 'no'].includes(normalized)) return false
  return null
}

function oppositeValues(a: string | null, b: string | null): boolean {
  const left = polarity(a); const right = polarity(b)
  return left !== null && right !== null && left !== right
}

function sameBase(oldFact: HistoricalFact, current: ExtractedResearchClaim): boolean {
  return normalize(oldFact.entityName) === normalize(current.entityName) && oldFact.claimType === current.claimType
}

function comparableProposition(oldFact: Pick<HistoricalFact, 'proposition'>, current: Pick<ExtractedResearchClaim, 'proposition'>): boolean {
  return Boolean(oldFact.proposition && current.proposition && normalize(oldFact.proposition) === normalize(current.proposition))
}

function comparePrice(oldFact: HistoricalFact, current: ExtractedResearchClaim): ClaimComparisonResult {
  const sourceIds = [...oldFact.sourceIds, ...current.sourceIds]
  if (!comparableProposition(oldFact, current)) return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'The records do not identify the same priced product or proposition.', sourceIds)
  if (!isComparablePriceType(oldFact.priceType) || !isComparablePriceType(current.priceType)) {
    return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'The standard or promotional price type is missing or unknown.', sourceIds)
  }
  const dimensions = [
    [oldFact.currency, current.currency], [oldFact.billingPeriod, current.billingPeriod], [oldFact.region, current.region],
    [oldFact.planOrVersion, current.planOrVersion], [oldFact.priceType, current.priceType],
  ]
  if (dimensions.some(([before, after]) => !before || !after || normalize(before) !== normalize(after))) {
    return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'Currency, billing period, region, plan, or standard/promotional price type is missing or incompatible.', sourceIds)
  }
  if (current.priceType === 'promotional' && (!oldFact.discountConditions || !current.discountConditions || normalize(oldFact.discountConditions) !== normalize(current.discountConditions))) {
    return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'The promotional discount conditions are missing or differ.', sourceIds)
  }
  if (current.priceType === 'standard' && normalize(oldFact.discountConditions) !== normalize(current.discountConditions)) {
    return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'The standard-price conditions are not comparable.', sourceIds)
  }
  const before = numberValue(oldFact.claimValue)
  const after = numberValue(current.claimValue)
  if (before === null || after === null) return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'Comparable numeric price amounts were not available.', sourceIds)
  return result(oldFact.claimText, current.claimText, before === after ? 'unchanged' : 'changed', before === after ? 'The comparable price amounts match.' : 'The comparable price amounts differ for the same stated dimensions.', sourceIds)
}

function comparePair(oldFact: HistoricalFact, current: ExtractedResearchClaim): ClaimComparisonResult {
  if (current.claimType === 'pricing') return comparePrice(oldFact, current)
  if (!comparableProposition(oldFact, current)) return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'The records do not establish the same specific proposition.', [...oldFact.sourceIds, ...current.sourceIds])
  if (normalize(oldFact.planOrVersion) !== normalize(current.planOrVersion) && (oldFact.planOrVersion || current.planOrVersion)) {
    return result(oldFact.claimText, current.claimText, 'insufficient_evidence', 'The product tier or version differs or is missing.', [...oldFact.sourceIds, ...current.sourceIds])
  }
  const conflicting = oppositeValues(oldFact.claimValue, current.claimValue)
  if (conflicting) return result(oldFact.claimText, current.claimText, 'conflicting', 'The same proposition has explicitly opposite structured values.', [...oldFact.sourceIds, ...current.sourceIds])
  const unchanged = normalize(oldFact.claimText) === normalize(current.claimText)
  return result(oldFact.claimText, current.claimText, unchanged ? 'unchanged' : 'insufficient_evidence', unchanged ? 'The normalized claims for the same proposition match.' : 'The descriptions differ, but the values do not establish a contradiction.', [...oldFact.sourceIds, ...current.sourceIds])
}

function samePricingDimensions(a: ExtractedResearchClaim, b: ExtractedResearchClaim): boolean {
  const complete = [a, b].every((claim) => claim.currency && claim.billingPeriod && claim.region && claim.planOrVersion && claim.priceType !== 'unknown'
    && (claim.priceType !== 'promotional' || claim.discountConditions))
  return Boolean(complete && a.proposition && b.proposition && normalize(a.entityName) === normalize(b.entityName) && normalize(a.proposition) === normalize(b.proposition)
    && normalize(a.currency) === normalize(b.currency) && normalize(a.billingPeriod) === normalize(b.billingPeriod)
    && normalize(a.region) === normalize(b.region) && normalize(a.planOrVersion) === normalize(b.planOrVersion)
    && a.priceType === b.priceType && normalize(a.discountConditions) === normalize(b.discountConditions))
}

export function compareHistoricalAndCurrent(history: HistoricalRetrieval, currentClaims: ExtractedResearchClaim[]): ClaimComparisonResult[] {
  const oldFacts = historicalFacts(history)
  if (!oldFacts.length && !currentClaims.length) return [result(null, null, 'insufficient_evidence', 'No comparable historical or current claims were retrieved.', [])]
  const results: ClaimComparisonResult[] = []
  const matchedOld = new Set<number>()
  for (let currentIndex = 0; currentIndex < currentClaims.length; currentIndex += 1) {
    const current = currentClaims[currentIndex]
    const baseMatches = oldFacts.map((fact, index) => ({ fact, index })).filter(({ fact }) => sameBase(fact, current))
    const matching = baseMatches.filter(({ fact }) => comparableProposition(fact, current))
    if (current.verification !== 'supported') {
      for (const { index } of matching) matchedOld.add(index)
      results.push(result(matching[0]?.fact.claimText ?? null, current.claimText, 'insufficient_evidence', 'The current claim did not pass evidence support verification.', [...matching.flatMap(({ fact }) => fact.sourceIds), ...current.sourceIds]))
      continue
    }
    if (matching.length) {
      for (const { fact, index } of matching) {
        matchedOld.add(index)
        results.push(fact.verificationStatus === 'supported'
          ? comparePair(fact, current)
          : result(fact.claimText, current.claimText, 'insufficient_evidence', 'The historical claim was not persisted as supported, so it cannot establish a definitive comparison.', [...fact.sourceIds, ...current.sourceIds]))
      }
    } else if (baseMatches.length && baseMatches.some(({ fact }) => fact.verificationStatus !== 'supported')) {
      for (const { index } of baseMatches) matchedOld.add(index)
      results.push(result(baseMatches[0].fact.claimText, current.claimText, 'insufficient_evidence', 'Related historical claims lack supported verification status, so novelty cannot be established safely.', [...baseMatches.flatMap(({ fact }) => fact.sourceIds), ...current.sourceIds]))
    } else if (baseMatches.length && current.proposition && baseMatches.every(({ fact }) => fact.proposition && normalize(fact.proposition) !== normalize(current.proposition))) {
      results.push(result(null, current.claimText, 'new_information', 'This is a distinct proposition from the historical claims retrieved; absence does not prove it is newly introduced.', current.sourceIds))
    } else if (baseMatches.length) {
      results.push(result(baseMatches[0].fact.claimText, current.claimText, 'insufficient_evidence', 'A related entity and claim type exists, but the proposition cannot be matched safely.', [...baseMatches.flatMap(({ fact }) => fact.sourceIds), ...current.sourceIds]))
    } else {
      results.push(result(null, current.claimText, oldFacts.length ? 'new_information' : 'insufficient_evidence', oldFacts.length ? 'No matching historical proposition was found; absence does not prove the fact is new.' : 'No historical claim was available for comparison.', current.sourceIds))
    }
  }
  oldFacts.forEach((fact, index) => {
    if (!matchedOld.has(index)) results.push(fact.verificationStatus === 'supported'
      ? result(fact.claimText, null, 'no_longer_verifiable', 'No current claim for this specific proposition was retrieved; this does not establish that it changed or became false.', fact.sourceIds)
      : result(fact.claimText, null, 'insufficient_evidence', 'This previously generated claim lacks supported verification status and cannot establish a historical fact.', fact.sourceIds))
  })
  for (let left = 0; left < currentClaims.length; left += 1) for (let right = left + 1; right < currentClaims.length; right += 1) {
    const a = currentClaims[left]; const b = currentClaims[right]
    const sameSubject = normalize(a.entityName) === normalize(b.entityName) && a.claimType === b.claimType && comparableProposition(a, b)
    const compatible = a.verification === 'supported' && b.verification === 'supported' && (a.claimType === 'pricing' ? samePricingDimensions(a, b) : sameSubject && normalize(a.planOrVersion) === normalize(b.planOrVersion))
    const conflictingValues = a.claimType === 'pricing' ? numberValue(a.claimValue) !== null && numberValue(b.claimValue) !== null && numberValue(a.claimValue) !== numberValue(b.claimValue) : oppositeValues(a.claimValue, b.claimValue)
    if (compatible && conflictingValues) {
      results.push(result(null, `${a.claimText} / ${b.claimText}`, 'conflicting', 'Current sources supplied different values for the same proposition and dimensions.', [...a.sourceIds, ...b.sourceIds]))
    }
  }
  return results.length ? results : [result(null, null, 'insufficient_evidence', 'The retrieved evidence did not support a comparison.', [])]
}
