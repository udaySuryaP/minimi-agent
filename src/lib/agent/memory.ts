import type { FinalAnswer, HistoricalRetrieval } from './contracts'

export type RememberedMemory = {
  entityType: 'fact' | 'preference' | 'decision' | 'topic' | 'product' | 'company' | 'other'
  entityName: string
  content: string
  validFrom?: string | null
  validTo?: string | null
}

const MAX_MEMORY_VALUE = 240
const monthAliases: Record<string, string> = {
  jan: 'january', january: 'january', januvary: 'january',
  feb: 'february', february: 'february', febuary: 'february',
  mar: 'march', march: 'march', apr: 'april', april: 'april', may: 'may',
  jun: 'june', june: 'june', jul: 'july', july: 'july', aug: 'august', august: 'august',
  sep: 'september', sept: 'september', september: 'september', septemeber: 'september',
  oct: 'october', october: 'october', nov: 'november', november: 'november', novemeber: 'november',
  dec: 'december', december: 'december', decemeber: 'december',
}
const monthPattern = 'january|januvary|february|febuary|march|april|may|june|july|august|september|septemeber|october|november|novemeber|december|decemeber|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec'

function clean(value: string): string {
  return value.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/[\s.]+$/, '').trim().slice(0, MAX_MEMORY_VALUE)
}

function isQuestion(value: string): boolean {
  return /^(?:what|whats|when|where|who|why|how|can|could|would|is|are|do|does|did|has|have|will)\b/i.test(value.trim())
    || /\?\s*\\?\s*$/.test(value)
}

function eventDateLabels(value: string): string[] {
  const labels = value.match(new RegExp(`\\b(?:${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'gi')) ?? []
  return [...new Set(labels.map((label) => label.replace(/\s+/g, ' ').trim()))]
}

function firstEventDate(value: string, referenceYear?: number): string | null {
  const label = eventDateLabels(value)[0]
  if (!label) return null
  const iso = label.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/i)
  if (!iso) return /^\d{4}-\d{2}-\d{2}$/.test(label) ? `${label}T00:00:00.000Z` : null
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
  const month = months[monthAliases[iso[1].toLowerCase()] ?? iso[1].toLowerCase()]
  const year = iso[3] ? Number(iso[3]) : referenceYear
  if (!month || !year) return null
  const date = new Date(Date.UTC(year, month - 1, Number(iso[2])))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function dateKeys(value: string): Set<string> {
  const keys = new Set<string>()
  for (const label of eventDateLabels(value)) {
    const match = label.match(/^(\w+)\s+(\d{1,2})/i)
    if (match) keys.add(`${monthAliases[match[1].toLowerCase()] ?? match[1].toLowerCase()}-${Number(match[2])}`)
    else if (/^\d{4}-\d{2}-\d{2}$/.test(label)) keys.add(label)
  }
  return keys
}

function monthKeys(value: string): Set<string> {
  const matches = value.match(new RegExp(`\\b(?:${monthPattern})\\b`, 'gi')) ?? []
  return new Set(matches.map((month) => monthAliases[month.toLowerCase()] ?? month.toLowerCase()))
}

const memoryRecallPattern = /\b(?:remember|saved information|personal memory|upcoming events?|my schedule|my notes|my information|shortlist|shortlisted)\b/i

export function isPersonalMemoryRecall(query: string): boolean {
  const personalCue = /\b(?:my|i|we|our|me|remember|saved|upcoming)\b/i.test(query)
  const memoryTopic = /\b(?:plan|planned|scheduled|schedule|meeting|appointment|calendar|events?)\b/i.test(query)
  const personalFactQuestion = /\b(?:what(?:'s| is)|what do I|where do I|who am I|tell me about)\s+(?:my|me|I|name|live|do|location|work|job|prefer|preferences?|interests?|favorite|personal information)\b/i.test(query)
    || /\b(?:what do i do|where do i live|what is my name|what do i prefer|what are my preferences)\b/i.test(query)
  const upcomingEventsQuestion = /\b(?:coming up|upcoming|next|scheduled|planned)\b/i.test(query) && /\b(?:events?|plans?|schedule|meetings?|calendar|appointments?)\b/i.test(query)
  const datePlansQuestion = /\b(?:is there anything|anything planned|anything scheduled|anything on|what do I have|what(?:'s| is| are))\s+(?:planned|scheduled|on|for|in|happening)\b/i.test(query)
  return memoryRecallPattern.test(query)
    || (personalCue && memoryTopic)
    || personalFactQuestion
    || upcomingEventsQuestion
    || datePlansQuestion
    || /\b(?:did I mention|what did I say|what project am I building|what project context)\b/i.test(query)
    || /\bwhat(?:'s| is| are)\s+(?:on|planned|scheduled|my upcoming)\b/i.test(query)
}

function displayDateLabel(value: string): string {
  return value.replace(/\b(jan(?:uary|uvary)?|feb(?:ruary|uary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember|temeber)?|sept(?:ember|emeber)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember|emeber)?)\b/gi, (month) => {
    const full = monthAliases[month.toLowerCase()] ?? month.toLowerCase()
    return full.charAt(0).toUpperCase() + full.slice(1)
  })
}

function displayMemoryFact(value: string): string {
  let fact = value.trim()
    .replace(/^The user noted a personal schedule:\s*/i, '')
    .replace(/^The user's planned and scheduled calendar note is:\s*/i, '')
    .replace(/\s+Event dates?:.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  fact = displayDateLabel(fact)
    .replace(/^The user's name is\s+/i, 'Your name is ')
    .replace(/^The user lives in\s+/i, 'You live in ')
    .replace(/^The user is from\s+/i, 'You are from ')
    .replace(/^The user works at\s+/i, 'You work at ')
    .replace(/^The user works on\s+/i, 'You work on ')
    .replace(/^The user works as\s+/i, 'You work as ')
    .replace(/^The user is building\s+/i, 'You are building ')
    .replace(/^The user plans to use\s+/i, 'You plan to use ')
    .replace(/^The user is comparing\s+/i, 'You are comparing ')
    .replace(/^The user studies at\s+/i, 'You study at ')
    .replace(/^The user prefers\s+/i, 'You prefer ')
    .replace(/^The user likes\s+/i, 'You like ')
    .replace(/^The user loves\s+/i, 'You love ')
    .replace(/^The user dislikes\s+/i, 'You dislike ')
    .replace(/^The user asked Minimi to remember that\s+/i, '')
    .replace(/\bI have\b/gi, 'you have')
    .replace(/\bI am\b/gi, 'you are')
    .replace(/\bI'm\b/gi, "you're")
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bI\b/g, 'you')
    .replace(/^(\w)/, (character) => character.toUpperCase())
    .replace(/^(On\s+\w+\s+\d+(?:st|nd|rd|th)?)(\s+)(you|your)\b/i, '$1, $3')
    .replace(/^(\w+\s+\d+(?:st|nd|rd|th)?)(\s+)(you|your)\b/i, '$1, $3')
  return /[.!?]$/.test(fact) ? fact : `${fact}.`
}

function eventEntityName(value: string): string {
  const match = value.match(/\b(exams?|tests?|meetings?|appointments?|calls?|interviews?|classes|lessons?|deadlines?|birthdays?|dates?|trips?|flights?|presentations?|reviews?|assignments?|submissions?|certification)\b/i)
  return match?.[1]?.toLowerCase() ?? 'personal schedule'
}

/**
 * Extracts only explicit, low-risk facts. The complete turn is still saved in
 * messages, while these records make common personal-assistant lookups fast.
 */
function extractSingleExplicitMemories(query: string, options: { referenceYear?: number } = {}): RememberedMemory[] {
  const value = query.trim().replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
  if (!value || /(password|passcode|otp|one[- ]time code|api key|secret)/i.test(value)) return []

  const patterns: Array<{ expression: RegExp; entityName: string; prefix: string; entityType?: RememberedMemory['entityType'] }> = [
    { expression: /^my name is\s+(.+)$/i, entityName: 'name', prefix: 'The user\'s name is' },
    { expression: /^i live in\s+(.+)$/i, entityName: 'location', prefix: 'The user lives in' },
    { expression: /^i am from\s+(.+)$/i, entityName: 'origin', prefix: 'The user is from' },
    { expression: /^i work (?:at|for)\s+(.+)$/i, entityName: 'work', prefix: 'The user works at' },
    { expression: /^i work on\s+(.+)$/i, entityName: 'work', prefix: 'The user works on' },
    { expression: /^i work as\s+(.+)$/i, entityName: 'work', prefix: 'The user works as' },
    { expression: /^i study at\s+(.+)$/i, entityName: 'education', prefix: 'The user studies at' },
    { expression: /^i prefer\s+(.+)$/i, entityName: 'preference', prefix: 'The user prefers', entityType: 'preference' },
    { expression: /^i am building\s+(.+)$/i, entityName: 'project', prefix: 'The user is building', entityType: 'product' },
    { expression: /^i plan to use\s+(.+)$/i, entityName: 'future technology plan', prefix: 'The user plans to use', entityType: 'decision' },
    { expression: /^i will use\s+(.+)$/i, entityName: 'future technology plan', prefix: 'The user plans to use', entityType: 'decision' },
    { expression: /^i am comparing\s+(.+)$/i, entityName: 'research topic', prefix: 'The user is comparing', entityType: 'topic' },
    { expression: /^remember that\s+(.+)$/i, entityName: 'user-provided fact', prefix: 'The user asked Minimi to remember that' },
  ]

  const compoundFacts = value.match(/^my name is\s+(.+?)\s+and\s+i prefer\s+(.+)$/i)
  if (compoundFacts) return [
    { entityType: 'fact', entityName: 'name', content: `The user's name is ${clean(compoundFacts[1])}.` },
    { entityType: 'preference', entityName: 'preference', content: `The user prefers ${clean(compoundFacts[2])}.` },
  ]
  const compoundWork = value.match(/^i live in\s+(.+?)\s+and\s+(?:i\s+)?work\s+(at|for|on|as)\s+(.+)$/i)
  if (compoundWork) return [
    { entityType: 'fact', entityName: 'location', content: `The user lives in ${clean(compoundWork[1])}.` },
    { entityType: 'fact', entityName: 'work', content: `The user works ${compoundWork[2].toLowerCase()} ${clean(compoundWork[3])}.` },
  ]

  const shortlist = value.match(/^(?:on\s+[^,]+,?\s+)?(?:i\s+)?shortlisted\s+(.+?)(?:\s+for\s+.+)?$/i)
  if (shortlist?.[1]) return [{ entityType: 'decision', entityName: 'research shortlist', content: `The user shortlisted ${clean(shortlist[1])}.` }]

  for (const pattern of patterns) {
    const match = value.match(pattern.expression)
    const detail = match?.[1] ? clean(match[1]) : ''
    if (detail) return [{ entityType: pattern.entityType ?? 'fact', entityName: pattern.entityName, content: `${pattern.prefix} ${detail}.` }]
  }

  const preference = value.match(/^i\s+(like|love|enjoy|dislike|hate)\s+(.+)$/i)
  if (preference?.[2]) {
    const verb = preference[1].toLowerCase() === 'enjoy' ? 'like' : preference[1].toLowerCase()
    return [{ entityType: 'preference', entityName: 'preference', content: `The user ${verb}s ${clean(preference[2])}.` }]
  }

  const genericFact = value.match(/^my\s+([a-z][a-z\s-]{1,40})\s+(?:is|are)\s+(.+)$/i)
  if (genericFact?.[2] && !/(password|passcode|otp|secret|api key)/i.test(genericFact[1])) {
    const entityName = genericFact[1].trim().replace(/\s+/g, ' ')
    return [{ entityType: 'fact', entityName, content: `The user's ${entityName} is ${clean(genericFact[2])}.` }]
  }

  // Calendar notes are user-provided facts even when they are not phrased as
  // “remember that”. Keep the original wording so a later question can match
  // names, dates, times, and the event relationship without guessing.
  const hasDate = new RegExp(`\\b(?:${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i').test(value)
  const hasEvent = /\b(meetings?|meet|appointments?|calls?|interviews?|exams?|tests?|classes|lessons?|dates?|reviews?|assignments?|submissions?|certification|submit|portfolio|予定|scheduled|schedule|agenda|founder|deadlines?|plans?|planned|birthdays?|trips?|flights?|presentations?)\b/i.test(value)
  if (hasDate && hasEvent && !isQuestion(value)) {
    const dates = eventDateLabels(value)
    if (dates.length <= 1) {
      const validFrom = firstEventDate(value, options.referenceYear)
      return [{ entityType: 'fact', entityName: eventEntityName(value), content: `The user noted a personal schedule: ${clean(value)}${dates.length ? ` Event date: ${dates[0]}.` : '.'}`, ...(validFrom ? { validFrom } : {}) }]
    }
    return dates.map((date, index) => {
      const start = value.toLowerCase().indexOf(date.toLowerCase())
      const next = index + 1 < dates.length ? value.toLowerCase().indexOf(dates[index + 1].toLowerCase(), start + date.length) : value.length
      const detail = clean(value.slice(start, next).replace(/^(?:and|then|[,;:])\s*/i, '').replace(/\s+(?:is\s+on|is|on|at|for)\s*$/i, ''))
      const validFrom = firstEventDate(date, options.referenceYear)
      return { entityType: 'fact', entityName: eventEntityName(detail), content: `The user noted a personal schedule: ${detail} Event date: ${date}.`, ...(validFrom ? { validFrom } : {}) }
    })
  }
  return []
}

export function extractExplicitMemories(query: string, options: { referenceYear?: number } = {}): RememberedMemory[] {
  const lines = query.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)
  if (lines.length > 1) return lines.flatMap((line) => extractSingleExplicitMemories(line, options))
  return extractSingleExplicitMemories(query, options)
}

export function buildDeterministicMemoryAnswer(query: string, history: HistoricalRetrieval): FinalAnswer | null {
  if (!isPersonalMemoryRecall(query)) return null
  const savedUserMessages = history.messages.filter((message) => message.role === 'user'
    && !isQuestion(message.content)
    && /\b(meetings?|appointments?|calls?|interviews?|exams?|tests?|classes|lessons?|reviews?|assignments?|submissions?|certification|schedule|scheduled|founder|deadlines?|plans?|planned|date|birthdays?|trips?|flights?|presentations?)\b/i.test(message.content))
  const derivedFactMessages = history.messages.filter((message) => message.role === 'user')
    .flatMap((message) => extractExplicitMemories(message.content).map((memory) => ({ content: memory.content, createdAt: message.createdAt })))
  const scheduleRecall = /\b(?:plan|planned|scheduled|schedule|meeting|appointment|calendar|event|upcoming|exam|test|coming up)\b/i.test(query)
  const personalFactRecall = /\b(?:what(?:'s| is) my|where do I|who am I|what do I|name|live|location|work|job|prefer|preference|interest|favorite|personal information|about me|did I mention|what did I say|project|building|plan to use|technolog)\b/i.test(query)
  const requestedFactTerms = (() => {
    const text = query.toLowerCase()
    const terms = new Set<string>()
    if (/\bname\b/.test(text)) terms.add('name')
    if (/\b(?:where do i live|location|live|from)\b/.test(text)) ['location', 'origin', 'lives in', 'from', 'live'].forEach((term) => terms.add(term))
    if (/\b(?:what do i do|work|job)\b/.test(text)) ['work', 'works as', 'works at', 'works on', 'works for'].forEach((term) => terms.add(term))
    if (/\b(?:prefer|preference|preferences|like|likes|favorite)\b/.test(text)) ['prefer', 'preference', 'likes', 'favorite'].forEach((term) => terms.add(term))
    if (/\b(?:project|building)\b/.test(text)) ['project', 'building', 'taskpilot'].forEach((term) => terms.add(term))
    if (/\b(?:plan to use|technolog|typescript|postgres)\b/.test(text)) ['future technology plan', 'plans to use', 'typescript', 'postgres', 'prefer', 'technology'].forEach((term) => terms.add(term))
    if (terms.size > 0) return Array.from(terms)
    const meaningful = text.match(/[a-z0-9]{3,}/g)?.filter((word) => !['what', 'did', 'mention', 'anything', 'about', 'that', 'have', 'with', 'from'].includes(word)) ?? []
    return meaningful.slice(0, 4)
  })()
  const savedMemories = history.memoryItems.filter((memory) => {
    if (!scheduleRecall && personalFactRecall) return !/schedule|meeting|appointment|exam|event/i.test(`${memory.entityName} ${memory.content}`)
    if (scheduleRecall && !personalFactRecall) return /\b(schedule|scheduled|meetings?|appointments?|calls?|interviews?|exams?|tests?|classes|lessons?|reviews?|assignments?|submissions?|certification|founder|deadlines?|plans?|planned|date|birthdays?|trips?|flights?|presentations?|portfolio)\b/i.test(`${memory.entityName} ${memory.content}`)
    return /\b(schedule|scheduled|meetings?|appointments?|calls?|interviews?|exams?|tests?|classes|lessons?|reviews?|assignments?|submissions?|certification|founder|deadlines?|plans?|planned|date|birthdays?|trips?|flights?|presentations?|name|location|work|education|preference|interest)\b/i.test(`${memory.entityName} ${memory.content}`)
  })
  const requestedDates = dateKeys(query)
  const requestedMonths = monthKeys(query)
  if (!savedMemories.length && !savedUserMessages.length && !derivedFactMessages.length) {
    const requestedLabel = eventDateLabels(query)[0] ?? [...requestedMonths][0]
    return { text: requestedLabel ? `I don’t have anything recorded for ${displayDateLabel(requestedLabel)}.` : personalFactRecall ? 'I don’t have that saved in your personal memory.' : 'I don’t have any matching plans saved.', citations: [], claims: [] }
  }
  const candidates = [
    ...savedMemories.map((memory) => ({ content: memory.content, createdAt: memory.createdAt })),
    ...savedUserMessages.map((message) => ({ content: message.content, createdAt: message.createdAt })),
    ...derivedFactMessages,
  ].filter((candidate, index, all) => {
    const canonical = displayMemoryFact(candidate.content).toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g, '$1')
    return all.findIndex((item) => displayMemoryFact(item.content).toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g, '$1') === canonical) === index
  })
    .filter((candidate) => !personalFactRecall || !requestedFactTerms.length || requestedFactTerms.some((term) => normalizeMemoryText(candidate.content).includes(term)))
    .filter((candidate) => (!requestedDates.size || [...requestedDates].some((date) => dateKeys(candidate.content).has(date)))
      && (!requestedMonths.size || [...requestedMonths].some((month) => monthKeys(candidate.content).has(month))))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
  if (!candidates.length) {
    const requestedLabel = eventDateLabels(query)[0] ?? [...requestedMonths][0]
    return { text: requestedLabel ? `I don’t have anything recorded for ${displayDateLabel(requestedLabel)}.` : personalFactRecall ? 'I don’t have that saved in your personal memory.' : 'I don’t have any matching plans saved.', citations: [], claims: [] }
  }
  const rendered = candidates.map(({ content }) => displayMemoryFact(content))
    .filter((content, index, all) => all.findIndex((item) => item.toLocaleLowerCase() === content.toLocaleLowerCase()) === index)
  const content = rendered.map((item) => `• ${item}`).join('\n\n')
  return {
    text: `Here’s what I found in your saved information:\n\n${content}`,
    citations: [],
    claims: [],
  }
}

function normalizeMemoryText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

export function buildDeterministicMemoryAcknowledgement(query: string): FinalAnswer | null {
  const memories = extractExplicitMemories(query)
  if (!memories.length) return null
  if (memories.length === 1) return { text: `I’ve noted this in your personal memory: ${displayMemoryFact(memories[0].content)}`, citations: [], claims: [] }
  return { text: `I’ve saved these details in your personal memory:\n\n${memories.map((memory) => `• ${displayMemoryFact(memory.content)}`).join('\n\n')}`, citations: [], claims: [] }
}

export function buildMemoryAcknowledgement(memories: RememberedMemory[]): FinalAnswer | null {
  if (!memories.length) return null
  const lines = memories.map((memory) => `• ${displayMemoryFact(memory.content)}`)
  return {
    text: lines.length === 1
      ? `I’ve saved this in your personal memory: ${displayMemoryFact(memories[0].content)}`
      : `I’ve saved these details in your personal memory:\n\n${lines.join('\n\n')}`,
    citations: [],
    claims: [],
  }
}
