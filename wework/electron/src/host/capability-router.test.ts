import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  HOST_CAPABILITIES,
  HostCapabilityError,
  HostCapabilityRouter,
} from './capability-router.js'

describe('HostCapabilityRouter', () => {
  test('exposes the decision route token capabilities separately from the model proxy', () => {
    expect(HOST_CAPABILITIES).toContain('smartApps.storeDecisionToken')
    expect(HOST_CAPABILITIES).toContain('smartApps.takeDecisionToken')
  })

  test('dispatches only explicitly granted capabilities', async () => {
    const router = new HostCapabilityRouter()
    const handler = vi.fn(async params => ({ echoed: params.value }))
    router.register('window.getState', handler)
    router.grant('@wegent/dsh-app-wework', ['window.getState'])

    await expect(
      router.invoke('@wegent/dsh-app-wework', 'window.getState', { value: 1 })
    ).resolves.toEqual({ echoed: 1 })
    await expect(router.invoke('@third-party/app', 'window.getState', {})).rejects.toMatchObject<
      Partial<HostCapabilityError>
    >({
      code: 'capability_denied',
    })
    await expect(
      router.invoke('@wegent/dsh-app-wework', 'process.spawn', {})
    ).rejects.toMatchObject<Partial<HostCapabilityError>>({
      code: 'unknown_capability',
    })
    expect(handler).toHaveBeenCalledOnce()
  })
})

describe('slow desktop host capability diagnostics', () => {
  const principal = '@wegent/dsh-app-wework'
  const sensitive = 'secret-token-in-params-result-error-or-principal'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T08:29:22.426Z'))
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1/control')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  test('records only registered capability timing and success status', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const router = new HostCapabilityRouter()
    const result = { token: sensitive, path: `/private/${sensitive}` }
    router.register('workspace.listOpeners', async () => {
      vi.advanceTimersByTime(1_500)
      return result
    })
    router.grant(principal, ['workspace.listOpeners'])

    await expect(
      router.invoke(principal, 'workspace.listOpeners', { token: sensitive })
    ).resolves.toBe(result)

    expect(log.mock.calls).toEqual([
      [
        '[Wework] Slow desktop host capability',
        {
          capability: 'workspace.listOpeners',
          startedAt: '2026-10-29T08:29:22.426Z',
          finishedAt: '2026-10-29T08:29:23.926Z',
          elapsedMs: 1_500,
          status: 'success',
        },
      ],
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive)
  })

  test('preserves the original failure without copying exception details', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = new Error(sensitive)
    const router = new HostCapabilityRouter()
    router.register('workspace.listOpeners', async () => {
      vi.advanceTimersByTime(1_500)
      throw error
    })
    router.grant(principal, ['workspace.listOpeners'])

    await expect(
      router.invoke(principal, 'workspace.listOpeners', { token: sensitive })
    ).rejects.toBe(error)

    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][1]).toEqual({
      capability: 'workspace.listOpeners',
      startedAt: '2026-10-29T08:29:22.426Z',
      finishedAt: '2026-10-29T08:29:23.926Z',
      elapsedMs: 1_500,
      status: 'failure',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive)
  })

  test('does not diagnose unknown, denied, or unregistered capabilities', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const router = new HostCapabilityRouter()
    router.register('window.getState', async () => null)
    router.grant(principal, ['workspace.listOpeners'])
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000)

    await expect(router.invoke(principal, sensitive, {})).rejects.toMatchObject({
      code: 'unknown_capability',
    })
    await expect(router.invoke(sensitive, 'window.getState', {})).rejects.toMatchObject({
      code: 'capability_denied',
    })
    await expect(router.invoke(principal, 'workspace.listOpeners', {})).rejects.toMatchObject({
      code: 'capability_unavailable',
    })
    expect(log).not.toHaveBeenCalled()
  })

  test('keeps ordinary application calls and fast E2E calls silent', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const router = new HostCapabilityRouter()
    router.register('window.getState', async () => {
      vi.advanceTimersByTime(999)
      return true
    })
    router.grant(principal, ['window.getState'])
    await expect(router.invoke(principal, 'window.getState', {})).resolves.toBe(true)
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', undefined)
    router.register('workspace.listOpeners', async () => {
      vi.advanceTimersByTime(10_000)
      return true
    })
    router.grant(principal, ['workspace.listOpeners'])
    await expect(router.invoke(principal, 'workspace.listOpeners', {})).resolves.toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  test('bounds slow diagnostics without changing invocation results', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const router = new HostCapabilityRouter()
    router.register('window.getState', async () => {
      vi.advanceTimersByTime(1_000)
      return true
    })
    router.grant(principal, ['window.getState'])
    for (let count = 0; count < 34; count += 1) {
      await expect(router.invoke(principal, 'window.getState', {})).resolves.toBe(true)
    }
    expect(log).toHaveBeenCalledTimes(32)
  })

  test('keeps the original outcome when the diagnostic sink fails', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('diagnostic sink failed')
    })
    const original = new Error(sensitive)
    const router = new HostCapabilityRouter()
    router.register('window.getState', async () => {
      vi.advanceTimersByTime(1_000)
      return true
    })
    router.register('workspace.listOpeners', async () => {
      vi.advanceTimersByTime(1_000)
      throw original
    })
    router.grant(principal, ['window.getState', 'workspace.listOpeners'])
    await expect(router.invoke(principal, 'window.getState', {})).resolves.toBe(true)
    await expect(router.invoke(principal, 'workspace.listOpeners', {})).rejects.toBe(original)
  })
})
