import { z } from 'zod'
import { sanitizeTimezone } from '@/lib/utils/timezone'
import { TemporalResolutionSchema, TemporalRetrievalFilterSchema, type Intent, type TemporalResolution, type TemporalRetrievalFilter } from './contracts'

type CalendarDate = { year: number; month: number; day: number }
type TemporalReference = TemporalResolution['references'][number]

const weekdays: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const months: Record<string, number> = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 }
const monthPattern = 'September|February|November|December|January|October|August|March|April|June|July|May|Sept|Sep|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Oct|Nov|Dec'
const numberWords: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

function localDate(timestamp: string, timezone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) }
}
function dateKey(date: CalendarDate): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`
}
function addDays(key: string, count: number): string {
  const date = new Date(`${key}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}
function fromDate(date: Date): string { return date.toISOString().slice(0, 10) }
function monthStart(year: number, month: number): string { return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01` }
function monthEnd(year: number, month: number): string {
  const end = new Date(0)
  end.setUTCHours(0, 0, 0, 0)
  end.setUTCFullYear(year, month, 0)
  return fromDate(end)
}
function shiftCalendarMonths(dateKeyValue: string, monthDelta: number): string {
  const date = new Date(`${dateKeyValue}T00:00:00.000Z`)
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthDelta, 1))
  const year = target.getUTCFullYear()
  const month = target.getUTCMonth() + 1
  const day = Math.min(date.getUTCDate(), Number(monthEnd(year, month).slice(-2)))
  return dateKey({ year, month, day })
}
function amountFor(value: string): number { return numberWords[value.toLowerCase()] ?? Number(value) }
function addReference(references: TemporalReference[], text: string, kind: TemporalReference['kind'], start: string | null, end: string | null, ambiguity: string | null = null) {
  if (references.some((reference) => reference.text.toLowerCase() === text.toLowerCase())) return
  references.push({ text, kind, start, end, ambiguity })
}
function dateReference(references: TemporalReference[], text: string, value: string) {
  const parsed = z.iso.date().safeParse(value)
  if (parsed.success) addReference(references, text, 'absolute_date', parsed.data, parsed.data)
  else addReference(references, text, 'ambiguous', null, null, `The date ${text} is invalid.`)
}
function previousWeekday(today: string, weekday: number): string {
  const current = new Date(`${today}T00:00:00Z`).getUTCDay()
  const delta = (current - weekday + 7) % 7 || 7
  return addDays(today, -delta)
}
function weekStart(today: string): string {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay()
  return addDays(today, -((day + 6) % 7))
}

export function localDateStartUtc(localDateKey: string, timezone: string): string {
  const targetDate = z.iso.date().parse(localDateKey)
  const normalizedTimezone = sanitizeTimezone(timezone)
  const [year, month, day] = targetDate.split('-').map(Number)
  const nominalUtc = Date.UTC(year, month - 1, day)
  let lower = nominalUtc - 36 * 60 * 60 * 1000
  let upper = nominalUtc + 36 * 60 * 60 * 1000
  const localKeyAt = (timestamp: number) => dateKey(localDate(new Date(timestamp).toISOString(), normalizedTimezone))
  while (localKeyAt(lower) >= targetDate) lower -= 24 * 60 * 60 * 1000
  while (localKeyAt(upper) < targetDate) upper += 24 * 60 * 60 * 1000
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2)
    if (localKeyAt(middle) >= targetDate) upper = middle
    else lower = middle
  }
  return new Date(upper).toISOString()
}

export function createTemporalRetrievalFilter(temporal: TemporalResolution, intent: Intent, query: string): TemporalRetrievalFilter | null {
  const dateReferences = temporal.references.filter((reference) => reference.start !== null && reference.end !== null)
  if (dateReferences.length === 0) return null
  const intervals = dateReferences.map(({ start, end }) => ({
    startAt: localDateStartUtc(start!, temporal.timezone),
    endAt: localDateStartUtc(addDays(end!, 1), temporal.timezone),
  })).sort((a, b) => a.startAt.localeCompare(b.startAt))
  const merged: Array<{ startAt: string; endAt: string }> = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous && interval.startAt <= previous.endAt) {
      if (interval.endAt > previous.endAt) previous.endAt = interval.endAt
    } else merged.push({ ...interval })
  }
  const target = /\b(?:what was true|what was valid|valid at the time|state of|status of)\b/i.test(query)
    ? 'memory_valid_time'
    : intent === 'historical_conversation_recall'
      ? 'messages'
      : intent === 'historical_research_recall'
        ? 'research_snapshots'
        : 'all'
  return TemporalRetrievalFilterSchema.parse({ target, timezone: temporal.timezone, intervals: merged })
}

export function resolveTemporalReferences(query: string, options: { timezone?: string; referenceTimestamp: string }): TemporalResolution {
  const timezone = sanitizeTimezone(options.timezone)
  const referenceTimestamp = z.iso.datetime({ offset: true }).parse(options.referenceTimestamp)
  const today = dateKey(localDate(referenceTimestamp, timezone))
  const todayDate = new Date(`${today}T00:00:00Z`)
  const currentYear = todayDate.getUTCFullYear()
  const currentMonth = todayDate.getUTCMonth() + 1
  const references: TemporalReference[] = []

  for (const match of query.matchAll(/\b(?:(the)\s+)?(last|this|next|previous)\s+(week|month|year)\b/gi)) {
    const direction = match[2].toLowerCase() === 'previous' ? 'last' : match[2].toLowerCase()
    const period = match[3].toLowerCase()
    if (period === 'week') {
      const start = weekStart(today)
      const offset = direction === 'last' ? -7 : direction === 'next' ? 7 : 0
      const rangeStart = addDays(start, offset)
      const rangeEnd = addDays(rangeStart, 6)
      addReference(references, match[0], 'date_range', rangeStart, rangeEnd)
    } else if (period === 'month') {
      const monthDate = new Date(Date.UTC(currentYear, currentMonth - 1 + (direction === 'last' ? -1 : direction === 'next' ? 1 : 0), 1))
      const year = monthDate.getUTCFullYear()
      const month = monthDate.getUTCMonth() + 1
      const start = monthStart(year, month)
      addReference(references, match[0], 'date_range', start, monthEnd(year, month))
    } else {
      const year = currentYear + (direction === 'last' ? -1 : direction === 'next' ? 1 : 0)
      const start = `${year}-01-01`
      addReference(references, match[0], 'date_range', start, `${year}-12-31`)
    }
  }

  // A named month with last/this/next is a complete calendar-month reference.
  // “Last November” means the most recent November before the reference month;
  // “next November” means the first November after it.
  const namedMonthPeriod = new RegExp(`\\b(last|this|next|previous)\\s+(${monthPattern})\\b`, 'gi')
  for (const match of query.matchAll(namedMonthPeriod)) {
    const direction = match[1].toLowerCase()
    const month = months[match[2].toLowerCase()]
    let year = currentYear
    if (direction === 'last' || direction === 'previous') {
      if (month >= currentMonth) year -= 1
    } else if (direction === 'next' && month <= currentMonth) year += 1
    addReference(references, match[0], 'date_range', monthStart(year, month), monthEnd(year, month))
  }

  const relativeSpan = /\b(last|past|previous|next)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?|years?)\b/gi
  for (const match of query.matchAll(relativeSpan)) {
    const direction = match[1].toLowerCase()
    const amount = amountFor(match[2])
    const unit = match[3].toLowerCase().replace(/s$/, '')
    const maxAmount = unit === 'day' ? 365 : unit === 'week' ? 52 : unit === 'month' ? 24 : 10
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxAmount) {
      addReference(references, match[0], 'ambiguous', null, null, `The relative range ${match[0]} is outside the supported range.`)
      continue
    }
    const isFuture = direction === 'next'
    if (unit === 'day' || unit === 'week') {
      const days = amount * (unit === 'week' ? 7 : 1)
      const start = isFuture ? addDays(today, 1) : addDays(today, -(days - 1))
      const end = isFuture ? addDays(today, days) : today
      addReference(references, match[0], 'date_range', start, end)
    } else {
      const monthsDelta = amount * (unit === 'year' ? 12 : 1) * (isFuture ? 1 : -1)
      const shifted = shiftCalendarMonths(today, monthsDelta)
      addReference(references, match[0], 'date_range', isFuture ? addDays(today, 1) : shifted, isFuture ? shifted : today)
    }
  }

  const relativeDay = /\b(?:in\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?|years?)|(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?|years?)\s+(ago|from\s+now))\b/gi
  for (const match of query.matchAll(relativeDay)) {
    const amount = amountFor(match[1] ?? match[3])
    const unit = (match[2] ?? match[4]).toLowerCase().replace(/s$/, '')
    const directionText = (match[5] ?? 'from now').toLowerCase()
    const direction = directionText === 'ago' ? -1 : 1
    const maxAmount = unit === 'day' ? 365 : unit === 'week' ? 52 : unit === 'month' ? 24 : 10
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxAmount) {
      addReference(references, match[0], 'ambiguous', null, null, `The relative date ${match[0]} is outside the supported range.`)
      continue
    }
    const value = unit === 'day' ? addDays(today, direction * amount)
      : unit === 'week' ? addDays(today, direction * amount * 7)
        : shiftCalendarMonths(today, direction * amount * (unit === 'year' ? 12 : 1))
    addReference(references, match[0], 'relative_date', value, value)
  }

  for (const match of query.matchAll(/\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/gi)) {
    const start = z.iso.date().safeParse(match[1])
    const end = z.iso.date().safeParse(match[2])
    if (start.success && end.success && start.data <= end.data) addReference(references, match[0], 'date_range', start.data, end.data)
    else addReference(references, match[0], 'ambiguous', null, null, 'The date range is invalid or its end comes before its start.')
  }
  for (const match of query.matchAll(/\bfrom\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})\b/gi)) {
    const start = z.iso.date().safeParse(match[1])
    const end = z.iso.date().safeParse(match[2])
    if (start.success && end.success && start.data <= end.data) addReference(references, match[0], 'date_range', start.data, end.data)
    else addReference(references, match[0], 'ambiguous', null, null, 'The date range is invalid or its end comes before its start.')
  }

  for (const match of query.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    if (references.some((reference) => reference.kind === 'date_range' && reference.text.includes(match[0]))) continue
    dateReference(references, match[0], match[1])
  }

  const relative = /\b(day before yesterday|day after tomorrow|a week ago|a fortnight ago|today|yesterday|tomorrow|last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(?:\d+|one|two|three|four|five|six|seven)\s+days?\s+ago|(?:\d+|one|two|three|four|five|six|seven)\s+weeks?\s+ago)\b/gi
  for (const match of query.matchAll(relative)) {
    const text = match[0].toLowerCase()
    let result: string
    if (text === 'day before yesterday') result = addDays(today, -2)
    else if (text === 'day after tomorrow') result = addDays(today, 2)
    else if (text === 'a week ago') result = addDays(today, -7)
    else if (text === 'a fortnight ago') result = addDays(today, -14)
    else if (text === 'today') result = today
    else if (text === 'yesterday') result = addDays(today, -1)
    else if (text === 'tomorrow') result = addDays(today, 1)
    else if (text.startsWith('last ')) result = previousWeekday(today, weekdays[match[2].toLowerCase()])
    else {
      const [amountText, unit] = text.split(/\s+/)
      const amount = numberWords[amountText] ?? Number(amountText)
      const days = unit.startsWith('week') ? amount * 7 : amount
      if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
        addReference(references, match[0], 'ambiguous', null, null, `The relative date ${match[0]} is outside the supported range.`)
        continue
      }
      result = addDays(today, -days)
    }
    addReference(references, match[0], 'relative_date', result, result)
  }

  // In conversational recall, an unqualified weekday means the most recent
  // completed occurrence, never a future date. If it is today, “today” and
  // “last week” are both plausible, so ask instead of choosing silently.
  const unqualifiedWeekday = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi
  for (const match of query.matchAll(unqualifiedWeekday)) {
    const prefix = query.slice(Math.max(0, match.index! - 16), match.index!).match(/\b(last|previous|next|this)\s+$/i)
    if (prefix) continue
    const weekday = weekdays[match[1].toLowerCase()]
    const current = new Date(`${today}T00:00:00Z`).getUTCDay()
    if (weekday === current) {
      addReference(references, match[0], 'ambiguous', null, null, `“${match[0]}” could mean today or the previous week; please clarify.`)
    } else {
      const daysBack = (current - weekday + 7) % 7 || 7
      const occurrence = addDays(today, -daysBack)
      addReference(references, match[0], 'relative_date', occurrence, occurrence)
    }
  }

  const namedDate = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`, 'gi')
  for (const match of query.matchAll(namedDate)) {
    const monthName = match[1] ?? match[5]
    const dayText = match[2] ?? match[4]
    const yearText = match[3] ?? match[6]
    const text = match[0]
    if (!yearText && Number(dayText) >= 1000) continue // Month-year phrases are resolved below.
    const year = yearText ?? '2000'
    const value = `${year}-${months[monthName.toLowerCase()].toString().padStart(2, '0')}-${dayText.padStart(2, '0')}`
    if (!z.iso.date().safeParse(value).success) addReference(references, text, 'ambiguous', null, null, `The date ${text} is invalid.`)
    else if (!yearText) addReference(references, text, 'ambiguous', null, null, `The year for ${text} is not specified.`)
    else dateReference(references, text, value)
  }

  const monthYear = new RegExp(`\\b(${monthPattern})\\s+(\\d{4})\\b`, 'gi')
  for (const match of query.matchAll(monthYear)) {
    const month = months[match[1].toLowerCase()]
    const year = Number(match[2])
    addReference(references, match[0], 'date_range', monthStart(year, month), monthEnd(year, month))
  }

  for (const match of query.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g)) {
    if (!match[3]) addReference(references, match[0], 'ambiguous', null, null, `The year and ordering for ${match[0]} are not specified.`)
    else {
      const first = Number(match[1])
      const second = Number(match[2])
      if (first <= 12 && second <= 12 && first !== second) addReference(references, match[0], 'ambiguous', null, null, `The month/day ordering for ${match[0]} is ambiguous.`)
      else dateReference(references, match[0], `${match[3]}-${(first > 12 ? second : first).toString().padStart(2, '0')}-${(first > 12 ? first : second).toString().padStart(2, '0')}`)
    }
  }

  const unresolvedPatterns = [
    /\b(?:\d+|one|two|three|four|five|six|seven|a|an|a few|several|a couple of?|couple)\s+(?:days?|weeks?|months?|years?)\s+ago\b/gi,
    /\b(?:last|past|previous|next)\s+(?:\d+|a few|several|couple of?)\s+(?:days?|weeks?|months?|years?)\b/gi,
    /\b(?:in|within)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|several|couple of?)\s+(?:days?|weeks?|months?|years?|fortnights?)\b/gi,
    /\b(?:\d+|one|two|three|four|five|six|seven|a few|several|couple of?)\s+(?:days?|weeks?|months?|years?)\s+(?:later|from today|from now)\b/gi,
    /\b(?:in the past|over the past)\s+(?:few|several|\d+)\s+days?\b/gi,
    /\b(?:the other day|recently|a while ago)\b/gi,
    /\b(?:last|next|this)\s+quarter\b/gi,
    /\b(?:next|this)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    /\bprevious\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    /\b(?:last|this|next)\s+weekend\b/gi,
    /\b(?:last|this|next)\s+(?:spring|summer|fall|autumn|winter)\b/gi,
  ]
  for (const expression of unresolvedPatterns) {
    for (const match of query.matchAll(expression)) {
      if (!references.some((reference) => reference.text.toLowerCase() === match[0].toLowerCase())) {
        addReference(references, match[0], 'ambiguous', null, null, `The date expression ${match[0]} needs clarification.`)
      }
    }
  }

  const monthOnlyCue = new RegExp(`\\b(?:in|during|since|until|throughout|by)\\s+(${monthPattern})\\b`, 'gi')
  for (const match of query.matchAll(monthOnlyCue)) {
    if (!references.some((reference) => reference.text.toLowerCase().includes(match[1].toLowerCase()))) {
      addReference(references, match[0], 'ambiguous', null, null, `The year or day for ${match[1]} is not specified.`)
    }
  }
  const partialMonthCue = new RegExp(`\\b(?:early|mid|late)\\s+(${monthPattern})\\b`, 'gi')
  for (const match of query.matchAll(partialMonthCue)) {
    if (!references.some((reference) => reference.text.toLowerCase().includes(match[1].toLowerCase()))) {
      addReference(references, match[0], 'ambiguous', null, null, `The year and day range for ${match[1]} are not specified.`)
    }
  }
  const bareMonth = new RegExp(`^\\s*(?:the month of\\s+)?(${monthPattern})[?.!,;\\s]*$`, 'i').exec(query)
  if (bareMonth) addReference(references, bareMonth[0].trim(), 'ambiguous', null, null, `The day or year for ${bareMonth[1]} is not specified.`)

  if (references.length === 0 && /\b(?:when|what date|which day|that day|then|back then)\b/i.test(query)) {
    addReference(references, query, 'unspecified', null, null, 'The time reference needs more detail.')
  }
  if (references.filter((reference) => reference.start !== null).length > 8) {
    addReference(references, 'many date references', 'ambiguous', null, null, 'Please narrow the request to eight or fewer separate date references.')
  }
  references.sort((a, b) => query.toLowerCase().indexOf(a.text.toLowerCase()) - query.toLowerCase().indexOf(b.text.toLowerCase()))
  return TemporalResolutionSchema.parse({ references, timezone, referenceTimestamp })
}
