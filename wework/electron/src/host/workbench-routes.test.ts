import { describe, expect, test, vi } from 'vitest'
import type { SmartAppInstallation } from './smart-app-manager.js'
import { WorkbenchRoutes } from './workbench-routes.js'

const installation = {
  id: 'notes',
  modelKey: 'selected',
  grantedCapabilities: { decisionModel: true },
} as SmartAppInstallation
const selected = {
  key: 'selected',
  displayName: 'Selected',
  context: { modelType: 'runtime' },
  upstream: { model_id: 'local' },
}

describe('installation-owned workbench routes', () => {
  test('a canceled lifetime cannot revoke a replacement when Executor reuses tokens by scope', async () => {
    const byScope = new Map<string, string>()
    const active = new Set<string>()
    let finish!: () => void
    let count = 0
    const request = vi.fn(async (method: string, input: Record<string, unknown>) => {
      if (method.endsWith('.unregister')) {
        active.delete(String(input.token))
        return {}
      }
      const scope = `${method}:${input.scope}`
      const token = byScope.get(scope) ?? `token-${byScope.size}`
      byScope.set(scope, token)
      active.add(token)
      if (method === 'runtime.harness_proxy.register' && ++count === 1)
        await new Promise<void>(resolve => {
          finish = resolve
        })
      return { token, baseUrl: 'http://127.0.0.1/route' }
    })
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected],
      user: async () => ({}),
    })
    const item = { ...installation, grantedCapabilities: { decisionModel: false } }
    const old = routes.acquire(item)
    const canceled = expect(old).rejects.toThrow('registration was canceled')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await routes.release(item.id)
    const current = await routes.acquire(item)
    finish()
    await canceled
    expect(current.tokens.every(({ token }) => active.has(token))).toBe(true)
    expect(await routes.acquire(item)).toBe(current)
    const scopes = request.mock.calls
      .filter(([method]) => method === 'runtime.harness_proxy.register')
      .map(([, input]) => input.scope)
    expect(new Set(scopes).size).toBe(2)
    await routes.dispose()
    expect(active.size).toBe(0)
  })
  test('an old Executor registration cannot overwrite the replacement Executor lease', async () => {
    let finish!: (value: { token: string; baseUrl: string }) => void
    let registers = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'runtime.harness_proxy.register' && ++registers === 1)
        return new Promise<{ token: string; baseUrl: string }>(resolve => {
          finish = resolve
        })
      return { token: `fresh-${method}`, baseUrl: 'http://127.0.0.1/fresh' }
    })
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected],
      user: async () => ({}),
    })
    const old = routes.acquire({ ...installation, grantedCapabilities: { decisionModel: false } })
    const canceled = expect(old).rejects.toThrow('registration was canceled')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    routes.invalidate()
    const fresh = await routes.acquire({
      ...installation,
      grantedCapabilities: { decisionModel: false },
    })
    finish({ token: 'old-executor-token', baseUrl: 'http://127.0.0.1/old' })
    await canceled
    expect(request).toHaveBeenCalledWith('runtime.harness_proxy.unregister', {
      token: 'old-executor-token',
    })
    expect(await routes.acquire(installation)).toBe(fresh)
    await routes.dispose()
    expect(request).toHaveBeenCalledWith('runtime.harness_proxy.unregister', {
      token: 'fresh-runtime.harness_proxy.register',
    })
  })
  test('registers once, retains tokens in Host, and releases every owned route', async () => {
    const request = vi.fn(async (method: string) => ({
      token: method,
      baseUrl: `http://127.0.0.1/${method}`,
      protocolVersion: 1,
    }))
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected],
      user: async () => ({ id: 1 }),
    })
    const lease = await routes.acquire(installation)
    expect(await routes.acquire(installation)).toBe(lease)
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'runtime.harness_proxy.register',
      'runtime.harness_context.register',
      'runtime.decision_proxy.register',
    ])
    await routes.release('notes')
    expect(
      request.mock.calls
        .slice(3)
        .map(call => call[0])
        .sort()
    ).toEqual([
      'runtime.decision_proxy.unregister',
      'runtime.harness_context.unregister',
      'runtime.harness_proxy.unregister',
    ])
  })
  test('a deleted selected model fails before granting routes', async () => {
    const request = vi.fn()
    const routes = new WorkbenchRoutes({ request, models: async () => [], user: async () => ({}) })
    await expect(routes.acquire(installation)).rejects.toThrow(
      'configured workbench model is unavailable'
    )
    expect(request).not.toHaveBeenCalled()
  })
  test('releases partial registrations and preserves the primary failure', async () => {
    const failure = new Error('Context rejected')
    const request = vi.fn(async (method: string) => {
      if (method === 'runtime.harness_context.register') throw failure
      return { token: 'owned-model-token', baseUrl: 'http://127.0.0.1/route' }
    })
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected],
      user: async () => ({}),
    })
    await expect(routes.acquire(installation)).rejects.toBe(failure)
    expect(request).toHaveBeenLastCalledWith('runtime.harness_proxy.unregister', {
      token: 'owned-model-token',
    })
  })
  test('retains both the registration failure and a failed release', async () => {
    const primary = new Error('Context failed')
    const cleanup = new Error('Unregister failed')
    const request = vi.fn(async (method: string) => {
      if (method === 'runtime.harness_context.register') throw primary
      if (method.endsWith('.unregister')) throw cleanup
      return { token: 'owned-token', baseUrl: 'http://127.0.0.1/route' }
    })
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected],
      user: async () => ({}),
    })
    await expect(routes.acquire(installation)).rejects.toMatchObject({
      errors: [primary, { errors: [cleanup] }],
    })
  })
  test('does not block the selected model when an optional catalog model was removed', async () => {
    const request = vi.fn(async (method: string, input: Record<string, unknown>) => {
      if (String(input.scope).endsWith(':removed')) throw new Error('Removed model')
      return { token: method, baseUrl: 'http://127.0.0.1/route' }
    })
    const report = vi.fn()
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected, { ...selected, key: 'removed' }],
      user: async () => ({}),
      report,
    })
    const lease = await routes.acquire({
      ...installation,
      grantedCapabilities: { decisionModel: false },
    })
    expect(lease.modelBaseUrl).toBe('http://127.0.0.1/route')
    expect(lease.additionalModels).toEqual([])
    expect(report).toHaveBeenCalledOnce()
    await routes.dispose()
  })
  test('canceled registration cleans its eventual token without releasing a newer lease', async () => {
    let finish!: (value: { token: string; baseUrl: string }) => void
    let count = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'runtime.harness_proxy.register' && ++count === 1)
        return new Promise<{ token: string; baseUrl: string }>(resolve => {
          finish = resolve
        })
      return { token: `new-${method}`, baseUrl: 'http://127.0.0.1/new' }
    })
    const routes = new WorkbenchRoutes({
      request: request as never,
      models: async () => [selected],
      user: async () => ({}),
    })
    const abort = new AbortController()
    const old = routes.acquire(
      { ...installation, grantedCapabilities: { decisionModel: false } },
      abort.signal
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    abort.abort(new Error('Canceled'))
    const current = await routes.acquire({
      ...installation,
      grantedCapabilities: { decisionModel: false },
    })
    finish({ token: 'old-model-token', baseUrl: 'http://127.0.0.1/old' })
    await expect(old).rejects.toThrow('Canceled')
    expect(request).toHaveBeenCalledWith('runtime.harness_proxy.unregister', {
      token: 'old-model-token',
    })
    expect(await routes.acquire(installation)).toBe(current)
    await routes.dispose()
  })
})
