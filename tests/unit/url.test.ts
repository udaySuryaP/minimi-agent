import { describe, it, expect } from 'vitest'
import { getSafeRedirectUrl } from '@/lib/utils/url'

describe('getSafeRedirectUrl', () => {
  describe('Safe internal paths', () => {
    it('returns default fallback /chat when input is null, undefined, or empty', () => {
      expect(getSafeRedirectUrl(null)).toBe('/chat')
      expect(getSafeRedirectUrl(undefined)).toBe('/chat')
      expect(getSafeRedirectUrl('')).toBe('/chat')
      expect(getSafeRedirectUrl('   ')).toBe('/chat')
    })

    it('uses custom fallback when provided', () => {
      expect(getSafeRedirectUrl(null, '/custom')).toBe('/custom')
      expect(getSafeRedirectUrl('', '/dashboard')).toBe('/dashboard')
    })

    it('allows valid internal paths', () => {
      expect(getSafeRedirectUrl('/chat')).toBe('/chat')
      expect(getSafeRedirectUrl('/chat/conversation-123')).toBe('/chat/conversation-123')
      expect(getSafeRedirectUrl('/settings')).toBe('/settings')
      expect(getSafeRedirectUrl('/api/health')).toBe('/api/health')
    })

    it('preserves query parameters and hash fragments on internal paths', () => {
      expect(getSafeRedirectUrl('/chat?topic=crm&page=2')).toBe('/chat?topic=crm&page=2')
      expect(getSafeRedirectUrl('/chat#section-3')).toBe('/chat#section-3')
      expect(getSafeRedirectUrl('/chat?q=postgres#results')).toBe('/chat?q=postgres#results')
    })

    it('trims leading/trailing whitespace on otherwise valid paths', () => {
      expect(getSafeRedirectUrl('  /chat  ')).toBe('/chat')
    })
  })

  describe('Unsafe external and protocol-relative targets (Open Redirect Prevention)', () => {
    it('rejects external HTTP/HTTPS URLs', () => {
      expect(getSafeRedirectUrl('https://evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('http://evil.com/phishing')).toBe('/chat')
      expect(getSafeRedirectUrl('https://evil.com/chat')).toBe('/chat')
    })

    it('rejects protocol-relative URLs (//example.com)', () => {
      expect(getSafeRedirectUrl('//evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('//evil.com/chat')).toBe('/chat')
      expect(getSafeRedirectUrl('///evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('////evil.com')).toBe('/chat')
    })

    it('rejects backslash-based bypass tricks', () => {
      expect(getSafeRedirectUrl('/\\evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('\\evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('\\\\evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('/path\\to\\evil')).toBe('/chat')
      expect(getSafeRedirectUrl('/chat\\@evil.com')).toBe('/chat')
    })

    it('rejects non-HTTP protocols and pseudo-protocols', () => {
      expect(getSafeRedirectUrl('javascript:alert(1)')).toBe('/chat')
      expect(getSafeRedirectUrl('data:text/html,<script>alert(1)</script>')).toBe('/chat')
      expect(getSafeRedirectUrl('vbscript:msgbox(1)')).toBe('/chat')
      expect(getSafeRedirectUrl('file:///etc/passwd')).toBe('/chat')
    })

    it('rejects relative paths without leading slash', () => {
      expect(getSafeRedirectUrl('chat')).toBe('/chat')
      expect(getSafeRedirectUrl('evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('evil.com/chat')).toBe('/chat')
    })

    it('rejects paths with embedded control characters or null bytes', () => {
      expect(getSafeRedirectUrl('/chat\0evil.com')).toBe('/chat')
      expect(getSafeRedirectUrl('/chat\r\nHeader: Injection')).toBe('/chat')
      expect(getSafeRedirectUrl('/chat\x08')).toBe('/chat')
    })
  })
})
