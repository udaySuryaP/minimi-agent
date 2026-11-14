import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeAgent: vi.fn(), createClient: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent/orchestrator', () => ({ executeAgent: mocks.executeAgent }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))

import { POST } from '@/app/api/agent/route'

function response(status: string) {
  return { status, intent: null, temporal: null, history: null, searchPlan: null, searchExecution: null, evidenceSources: [], extractedClaims: [], comparisons: [], snapshotId: null, answer: null, error: status === 'failed' ? { code: 'PROVIDER_ERROR', message: 'All planned web searches failed.' } : null }
}

describe('agent API outcome mapping', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'test-only-key')
    vi.stubEnv('TAVILY_API_KEY', 'test-only-key')
    mocks.executeAgent.mockImplementation(async () => response('completed'))
    mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: 'b879e41c-5110-485f-a9be-7cd85a2b8ad9' } }, error: null }) }, from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: { timezone: 'UTC' }, error: null }) }) })
  })
  async function post() { return POST(new Request('http://localhost/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'latest product update' }) })) }

  it('returns service unavailable and a failed body when all searches fail', async () => {
    mocks.executeAgent.mockImplementationOnce(async () => response('failed'))
    const result = await post()
    expect(result.status).toBe(503)
    expect(await result.json()).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } })
  })

  it('returns partial research as a successful response with its failure details intact', async () => {
    mocks.executeAgent.mockImplementationOnce(async () => ({ ...response('partial'), error: { code: 'PROVIDER_ERROR', message: 'Some searches failed.' } }))
    const result = await post()
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ status: 'partial', error: { code: 'PROVIDER_ERROR' } })
  })

  it('keeps no-search and clarification outcomes distinct and successful at the HTTP layer', async () => {
    mocks.executeAgent.mockImplementationOnce(async () => response('no_search'))
    expect((await post()).status).toBe(200)
    mocks.executeAgent.mockImplementationOnce(async () => response('needs_clarification'))
    expect((await post()).status).toBe(200)
  })

  it('does not configure Tavily or persistence when only Gemini is configured', async () => {
    vi.stubEnv('TAVILY_API_KEY', '')
    await post()
    const dependencies = mocks.executeAgent.mock.calls[0]?.[2]
    expect(dependencies).toMatchObject({ tavily: undefined, persistence: undefined })
    expect(dependencies?.reasoner).toBeDefined()
  })
})
