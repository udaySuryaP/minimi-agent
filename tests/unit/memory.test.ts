import { describe, expect, it } from 'vitest'
import { buildDeterministicMemoryAnswer, extractExplicitMemories } from '@/lib/agent/memory'

describe('explicit personal memory extraction', () => {
  it('captures a user-provided fact for later retrieval', () => {
    expect(extractExplicitMemories('My name is Uday')).toEqual([
      { entityType: 'fact', entityName: 'name', content: "The user's name is Uday." },
    ])
  })

  it('captures preferences and does not persist credential-like content', () => {
    expect(extractExplicitMemories('I prefer dark mode')).toEqual([
      { entityType: 'preference', entityName: 'preference', content: 'The user prefers dark mode.' },
    ])
    expect(extractExplicitMemories('My password is secret123')).toEqual([])
    expect(extractExplicitMemories('I like concise answers')).toEqual([{ entityType: 'preference', entityName: 'preference', content: 'The user likes concise answers.' }])
    expect(extractExplicitMemories('My favorite editor is VS Code')).toEqual([{ entityType: 'fact', entityName: 'favorite editor', content: "The user's favorite editor is VS Code." }])
  })

  it('leaves ordinary questions for conversation history without inventing a memory', () => {
    expect(extractExplicitMemories('What is the latest news about AI?')).toEqual([])
  })

  it('captures dated meeting notes for later calendar-style follow-ups', () => {
    expect(extractExplicitMemories('November 2 I had a meeting and the next meeting with the founder is on November 17th 2pm')).toEqual([
      { entityType: 'fact', entityName: 'meeting', content: 'The user noted a personal schedule: November 2 I had a meeting and the next meeting with the founder Event date: November 2.' },
      { entityType: 'fact', entityName: 'personal schedule', content: 'The user noted a personal schedule: November 17th 2pm Event date: November 17th.' },
    ])
  })

  it('does not save a calendar question as a new memory when punctuation is missing', () => {
    expect(extractExplicitMemories('whats planned for november 17th\\')).toEqual([])
  })

  it('stores dated exams and other personal schedule items with event-date context', () => {
    expect(extractExplicitMemories('December 2nd I have an exam', { referenceYear: 2026 })).toEqual([{
      entityType: 'fact', entityName: 'exam', content: 'The user noted a personal schedule: December 2nd I have an exam Event date: December 2nd.', validFrom: '2026-12-02T00:00:00.000Z',
    }])
  })

  it('captures reviews and assignment submissions as dated events', () => {
    expect(extractExplicitMemories('On November 28, I have a portfolio review', { referenceYear: 2026 })[0]?.entityName).toBe('review')
    expect(extractExplicitMemories('On December 15, I need to submit my design assignment', { referenceYear: 2026 })[0]?.entityName).toBe('assignment')
  })

  it('captures a research shortlist as a durable baseline note', () => {
    expect(extractExplicitMemories('On Monday, I shortlisted Notion, Asana, Linear, Trello, and ClickUp for a design team.')[0]).toMatchObject({ entityName: 'research shortlist' })
  })

  it('captures project context and intentions without changing their meaning', () => {
    expect(extractExplicitMemories('I am building a SaaS product called TaskPilot.')[0]).toMatchObject({ entityType: 'product', content: 'The user is building a SaaS product called TaskPilot.' })
    expect(extractExplicitMemories('I plan to use PostgreSQL and TypeScript for TaskPilot.')[0]).toMatchObject({ entityType: 'decision', content: 'The user plans to use PostgreSQL and TypeScript for TaskPilot.' })
    expect(extractExplicitMemories('1. I am comparing hosting options for a Node.js application.')[0]).toMatchObject({ entityType: 'topic', content: 'The user is comparing hosting options for a Node.js application.' })
  })

  it('captures common date typos and a plain date event', () => {
    expect(extractExplicitMemories('on december 1 i have date', { referenceYear: 2026 })[0]?.validFrom).toBe('2026-12-01T00:00:00.000Z')
    expect(extractExplicitMemories('on januvary 22 i have another exams', { referenceYear: 2026 })[0]?.validFrom).toBe('2026-01-22T00:00:00.000Z')
  })

  it('extracts each line from a multiline personal-context paste', () => {
    const memories = extractExplicitMemories('My name is Uday and I prefer concise answers.\n\nI live in Bengaluru and I work as a product designer.\n\nOn November 23, I have exams.')
    expect(memories).toHaveLength(5)
    expect(memories.some((memory) => memory.content === 'The user works as a product designer.')).toBe(true)
  })

  it('maps month-only schedule questions to events in that month', () => {
    const answer = buildDeterministicMemoryAnswer('What do I have planned in January?', {
      messages: [], memoryItems: [{ id: '00000000-0000-4000-8000-000000000001', entityName: 'exam', content: 'The user noted a personal schedule: January 22nd I have another exam. Event date: January 22nd.', validFrom: null, validTo: null, createdAt: '2026-11-15T10:00:00.000Z' }], researchSnapshots: [],
    })
    expect(answer?.text).toContain('January 22nd')
  })

  it('answers from the earlier factual message instead of echoing the recall question', () => {
    const answer = buildDeterministicMemoryAnswer('what is planned for nov 17?', {
      messages: [
        { id: '00000000-0000-4000-8000-000000000001', conversationId: '00000000-0000-4000-8000-000000000002', role: 'user', content: 'November 12 I have a date and November 17th I have a founders meeting.', createdAt: '2026-11-14T10:00:00.000Z' },
        { id: '00000000-0000-4000-8000-000000000003', conversationId: '00000000-0000-4000-8000-000000000002', role: 'user', content: 'what is planned for nov 17?', createdAt: '2026-11-14T10:01:00.000Z' },
      ],
      memoryItems: [], researchSnapshots: [],
    })
    expect(answer?.text).toContain('founders meeting')
    expect(answer?.text).not.toContain('what is planned for nov 17')
  })

  it('does not expose saved schedule memory to unrelated conversational questions', () => {
    expect(buildDeterministicMemoryAnswer('What do you think of black holes?', {
      messages: [], memoryItems: [{ id: '00000000-0000-4000-8000-000000000001', entityName: 'meeting', content: 'The user noted a personal schedule: December 2nd I have a meeting.', validFrom: null, validTo: null, createdAt: '2026-11-15T10:00:00.000Z' }], researchSnapshots: [],
    })).toBeNull()
  })

  it('answers a missing date directly and naturally', () => {
    expect(buildDeterministicMemoryAnswer('What is planned for November 23?', { messages: [], memoryItems: [], researchSnapshots: [] })?.text).toBe('I don’t have anything recorded for November 23.')
  })

  it('maps general personal facts to the matching saved memory', () => {
    expect(buildDeterministicMemoryAnswer('What is my name?', {
      messages: [], memoryItems: [{ id: '00000000-0000-4000-8000-000000000001', entityName: 'name', content: "The user's name is Uday.", validFrom: null, validTo: null, createdAt: '2026-11-15T10:00:00.000Z' }], researchSnapshots: [],
    })?.text).toContain('Your name is Uday.')
  })

  it('derives a personal fact from an older user message when structured memory is missing', () => {
    const answer = buildDeterministicMemoryAnswer('What is my name?', {
      messages: [{ id: '00000000-0000-4000-8000-000000000001', conversationId: '00000000-0000-4000-8000-000000000002', role: 'user', content: 'My name is Uday and I prefer concise answers.', createdAt: '2026-11-15T10:00:00.000Z' }], memoryItems: [], researchSnapshots: [],
    })
    expect(answer?.text).toContain('Your name is Uday.')
  })

  it('returns all matching saved events for an upcoming-events question', () => {
    const answer = buildDeterministicMemoryAnswer('What are my upcoming events?', {
      messages: [],
      memoryItems: [
        { id: '00000000-0000-4000-8000-000000000001', entityName: 'meeting', content: 'The user noted a personal schedule: November 24th I have a PTA meeting. Event date: November 24th.', validFrom: null, validTo: null, createdAt: '2026-11-15T10:00:00.000Z' },
        { id: '00000000-0000-4000-8000-000000000002', entityName: 'exam', content: 'The user noted a personal schedule: December 2nd I have an exam. Event date: December 2nd.', validFrom: null, validTo: null, createdAt: '2026-11-15T10:01:00.000Z' },
      ], researchSnapshots: [],
    })
    expect(answer?.text).toContain('November 24th')
    expect(answer?.text).toContain('December 2nd')
  })

  it('answers compound personal recall questions with multiple matching memories', () => {
    const memories = extractExplicitMemories('My name is Alex and I prefer TypeScript and PostgreSQL.')
    const answer = buildDeterministicMemoryAnswer('What is my name and what technology do I prefer?', {
      messages: [],
      memoryItems: memories.map((m, i) => ({
        id: `00000000-0000-4000-8000-00000000000${i + 1}`,
        entityName: m.entityName,
        content: m.content,
        validFrom: null,
        validTo: null,
        createdAt: '2026-11-15T10:00:00.000Z',
      })),
      researchSnapshots: [],
    })
    expect(answer?.text).toContain('Your name is Alex.')
    expect(answer?.text).toContain('You prefer TypeScript and PostgreSQL.')
  })

  it('answers date-specific schedule queries and handles month typos', () => {
    const memories = [
      ...extractExplicitMemories('On November 28, I have a portfolio review.', { referenceYear: 2026 }),
      ...extractExplicitMemories('On December 3, I have a meeting with a startup founder', { referenceYear: 2026 }),
      ...extractExplicitMemories('On January 10, I have a certification exam.', { referenceYear: 2026 }),
    ]
    const history = {
      messages: [],
      memoryItems: memories.map((m, i) => ({
        id: `00000000-0000-4000-8000-00000000000${i + 1}`,
        entityName: m.entityName,
        content: m.content,
        validFrom: m.validFrom ?? null,
        validTo: null,
        createdAt: '2026-11-15T10:00:00.000Z',
      })),
      researchSnapshots: [],
    }

    const answerNov = buildDeterministicMemoryAnswer('What is planned for November 28?', history)
    expect(answerNov?.text).toContain('portfolio review')

    const answerDec = buildDeterministicMemoryAnswer('What is planned for December 3?', history)
    expect(answerDec?.text).toContain('meeting with a startup founder')

    const answerTypoNov = buildDeterministicMemoryAnswer('Is there anything on Novemeber 28?', history)
    expect(answerTypoNov?.text).toContain('portfolio review')

    const answerTypoJan = buildDeterministicMemoryAnswer('What is planned for Januvary 10?', history)
    expect(answerTypoJan?.text).toContain('certification exam')

    const answerUpcoming = buildDeterministicMemoryAnswer('What events are coming up?', history)
    expect(answerUpcoming?.text).toContain('portfolio review')
    expect(answerUpcoming?.text).toContain('meeting with a startup founder')
    expect(answerUpcoming?.text).toContain('certification exam')
  })

  it('answers profession recall questions from user job context', () => {
    const memories = extractExplicitMemories('I live in Bengaluru and work as a backend engineer.')
    const answer = buildDeterministicMemoryAnswer('What do I do?', {
      messages: [],
      memoryItems: memories.map((m, i) => ({
        id: `00000000-0000-4000-8000-00000000000${i + 1}`,
        entityName: m.entityName,
        content: m.content,
        validFrom: null,
        validTo: null,
        createdAt: '2026-11-15T10:00:00.000Z',
      })),
      researchSnapshots: [],
    })
    expect(answer?.text).toContain('backend engineer')
  })
})
