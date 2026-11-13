import { describe, it, expect } from 'vitest'
import { matchesPathPrefix, matchesAnyPrefix } from '@/lib/utils/path'

describe('matchesPathPrefix', () => {
  it('matches exact paths', () => {
    expect(matchesPathPrefix('/chat', '/chat')).toBe(true)
    expect(matchesPathPrefix('/login', '/login')).toBe(true)
    expect(matchesPathPrefix('/signup', '/signup')).toBe(true)
    expect(matchesPathPrefix('/api/conversations', '/api/conversations')).toBe(true)
  })

  it('matches subpaths correctly with trailing slashes', () => {
    expect(matchesPathPrefix('/chat/123', '/chat')).toBe(true)
    expect(matchesPathPrefix('/chat/conversation/abc', '/chat')).toBe(true)
    expect(matchesPathPrefix('/api/conversations/123', '/api/conversations')).toBe(true)
    expect(matchesPathPrefix('/signup/confirm', '/signup')).toBe(true)
  })

  it('handles prefixes configured with trailing slashes', () => {
    expect(matchesPathPrefix('/chat', '/chat/')).toBe(true)
    expect(matchesPathPrefix('/chat/123', '/chat/')).toBe(true)
  })

  it('rejects partial word matches (path boundary defense)', () => {
    // Crucial security test cases
    expect(matchesPathPrefix('/chatty', '/chat')).toBe(false)
    expect(matchesPathPrefix('/chatter', '/chat')).toBe(false)
    expect(matchesPathPrefix('/chat-box', '/chat')).toBe(false)
    expect(matchesPathPrefix('/signup-bonus', '/signup')).toBe(false)
    expect(matchesPathPrefix('/logistics', '/login')).toBe(false)
    expect(matchesPathPrefix('/api/conversations_fake', '/api/conversations')).toBe(false)
  })

  it('handles empty or invalid inputs', () => {
    expect(matchesPathPrefix('', '/chat')).toBe(false)
    expect(matchesPathPrefix('/chat', '')).toBe(false)
  })
})

describe('matchesAnyPrefix', () => {
  const protectedPrefixes = ['/chat', '/api/conversations', '/api/memory', '/api/research'] as const

  it('matches valid routes in the list', () => {
    expect(matchesAnyPrefix('/chat', protectedPrefixes)).toBe(true)
    expect(matchesAnyPrefix('/chat/123', protectedPrefixes)).toBe(true)
    expect(matchesAnyPrefix('/api/conversations', protectedPrefixes)).toBe(true)
    expect(matchesAnyPrefix('/api/memory/search', protectedPrefixes)).toBe(true)
  })

  it('rejects routes not in the list or partial word routes', () => {
    expect(matchesAnyPrefix('/chatty', protectedPrefixes)).toBe(false)
    expect(matchesAnyPrefix('/api/health', protectedPrefixes)).toBe(false)
    expect(matchesAnyPrefix('/login', protectedPrefixes)).toBe(false)
    expect(matchesAnyPrefix('/signup', protectedPrefixes)).toBe(false)
  })
})
