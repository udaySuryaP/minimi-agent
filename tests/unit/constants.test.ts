import { describe, it, expect } from 'vitest'
import {
  MAX_SEARCH_CALLS,
  MAX_RESULTS_PER_CALL,
  SEARCH_TIMEOUT_MS,
  TOTAL_SEARCH_BUDGET_MS,
  DEFAULT_TIMEZONE,
  parseBoundedInt,
} from '@/lib/utils/constants'
import { AppError, AuthError, NotFoundError, ValidationError } from '@/lib/utils/errors'

describe('Application Constants', () => {
  it('has bounded search call limits', () => {
    expect(MAX_SEARCH_CALLS).toBe(8)
    expect(MAX_RESULTS_PER_CALL).toBe(5)
    expect(SEARCH_TIMEOUT_MS).toBe(8000)
    expect(TOTAL_SEARCH_BUDGET_MS).toBe(30000)
    expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata')
  })

  describe('parseBoundedInt', () => {
    it('returns default value when input is undefined, null, or empty', () => {
      expect(parseBoundedInt(undefined, 8, 1, 20)).toBe(8)
      expect(parseBoundedInt(null as unknown as string, 8, 1, 20)).toBe(8)
      expect(parseBoundedInt('', 8, 1, 20)).toBe(8)
    })

    it('parses valid integer strings within bounds', () => {
      expect(parseBoundedInt('5', 8, 1, 20)).toBe(5)
      expect(parseBoundedInt('1', 8, 1, 20)).toBe(1)
      expect(parseBoundedInt('20', 8, 1, 20)).toBe(20)
    })

    it('rejects values below minimum bound', () => {
      expect(parseBoundedInt('0', 8, 1, 20)).toBe(8)
      expect(parseBoundedInt('-5', 8, 1, 20)).toBe(8)
    })

    it('rejects values above maximum bound', () => {
      expect(parseBoundedInt('21', 8, 1, 20)).toBe(8)
      expect(parseBoundedInt('999999', 8, 1, 20)).toBe(8)
    })

    it('rejects non-numeric or malformed values', () => {
      expect(parseBoundedInt('invalid', 8, 1, 20)).toBe(8)
      expect(parseBoundedInt('NaN', 8, 1, 20)).toBe(8)
      expect(parseBoundedInt('8.5', 8, 1, 20)).toBe(8) // parseBoundedInt handles or parses int
    })
  })
})

describe('Application Errors', () => {
  it('creates AppError with code and statusCode', () => {
    const err = new AppError('test error', 'TEST_CODE', 400)
    expect(err.message).toBe('test error')
    expect(err.code).toBe('TEST_CODE')
    expect(err.statusCode).toBe(400)
  })

  it('creates AuthError with default status 401', () => {
    const err = new AuthError()
    expect(err.statusCode).toBe(401)
    expect(err.code).toBe('AUTH_REQUIRED')
  })

  it('creates NotFoundError with 404', () => {
    const err = new NotFoundError('Conversation')
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Conversation not found')
  })

  it('creates ValidationError with 400', () => {
    const err = new ValidationError('Invalid input')
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
  })
})
