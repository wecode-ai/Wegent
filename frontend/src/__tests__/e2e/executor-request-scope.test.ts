/** @jest-environment node */

import type { APIRequestContext } from '@playwright/test'
import {
  bindExecutorRequest,
  executorRequestMockUrl,
  executorRequestUser,
  executorWorkerScope,
} from '../../../e2e/utils/executor-request-scope'
import {
  MockScopeStore,
  mockRequestScope,
  scopedMockUrl,
  withMockScope,
} from '../../../e2e/utils/mock-scope'

describe('Executor worker isolation', () => {
  const admin = {
    username: 'admin',
    password: 'test-only',
    role: 'admin' as const,
    description: 'test',
  }

  it('binds accounts and provider endpoints to the request without changing other requests or roles', () => {
    const a = {} as APIRequestContext
    const b = {} as APIRequestContext
    bindExecutorRequest(a, 'worker-a', { ...admin, username: 'isolated-a' })
    bindExecutorRequest(b, 'worker-b', { ...admin, username: 'isolated-b' })
    expect(executorRequestUser(a, admin)).toEqual({ ...admin, username: 'isolated-a' })
    expect(executorRequestUser(b, admin)).toEqual({ ...admin, username: 'isolated-b' })
    expect(executorRequestMockUrl(a, 'http://provider')).toBe('http://provider/e2e/worker-a')
    expect(executorRequestMockUrl(b, 'http://provider')).toBe('http://provider/e2e/worker-b')
    const unbound = {} as APIRequestContext
    expect(executorRequestUser(unbound, admin)).toBe(admin)
    expect(executorRequestMockUrl(unbound, 'http://provider')).toBe('http://provider')
  })

  it('separates runs, attempts and worker identities while staying stable within one worker', () => {
    const env = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }
    const first = executorWorkerScope(env, 0)
    expect(executorWorkerScope(env, 0)).toBe(first)
    expect(
      new Set([
        first,
        executorWorkerScope(env, 1),
        executorWorkerScope({ ...env, GITHUB_RUN_ID: '124' }, 0),
        executorWorkerScope({ ...env, GITHUB_RUN_ATTEMPT: '2' }, 0),
      ]).size
    ).toBe(4)
  })

  it('retains state across interleaved asynchronous work and normalizes only the explicit scope prefix', async () => {
    const states = new MockScopeStore(() => ({ values: [] as string[] }))
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const a = withMockScope('worker-a', async () => {
      states.current().values.push('a')
      await gate
      expect(states.current().values).toEqual(['a'])
    })
    await withMockScope('worker-b', async () => {
      states.current().values.push('b')
      await Promise.resolve()
      expect(states.current().values).toEqual(['b'])
      release()
    })
    await a
    const request = { url: '/e2e/worker-b/mcp?service=docs' }
    expect(mockRequestScope(request)).toBe('worker-b')
    expect(request.url).toBe('/mcp?service=docs')
    expect(() => scopedMockUrl('http://provider', '../other')).toThrow('Invalid mock scope')
    expect(() => mockRequestScope({ url: '/e2e/bad%20scope/v1/messages' })).toThrow(
      'Invalid mock request scope'
    )
  })
})
