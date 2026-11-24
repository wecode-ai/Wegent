import { beforeEach, expect, test, vi } from 'vitest'
import type { ModelConfigurationSnapshot } from './providerModelConfiguration'

const host = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: host.invoke,
  subscribeDesktopHostEvents: host.subscribe,
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

function snapshot(revision: string): ModelConfigurationSnapshot {
  return { path: '/test/models.yml', revision, loadedAt: '', providers: [] }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  host.invoke.mockReset()
  host.subscribe.mockReset().mockReturnValue(() => {})
})

test('observes a revision change while the initial read is pending and shares initialization', async () => {
  const configuration = await import('./providerModelConfiguration')
  let finishInitial!: (value: ModelConfigurationSnapshot) => void
  const initialRead = new Promise<ModelConfigurationSnapshot>(resolve => {
    finishInitial = resolve
  })
  let reads = 0
  host.invoke.mockImplementation(async method => {
    if (method === 'modelConfiguration.read') {
      reads += 1
      return reads === 1 ? initialRead : snapshot('new')
    }
    if (method === 'modelConfiguration.runtime') return { revision: 'new', models: [] }
    throw new Error(`Unexpected invocation: ${method}`)
  })

  const initialized = configuration.initializeProviderModelConfiguration()
  expect(configuration.initializeProviderModelConfiguration()).toBe(initialized)
  expect(host.subscribe).toHaveBeenCalledTimes(1)
  expect(host.invoke).toHaveBeenCalledTimes(1)
  host.subscribe.mock.calls[0][0]({ type: 'model-configuration.changed' })
  await vi.waitFor(() => {
    expect(configuration.getProviderConfigurationState().snapshot?.revision).toBe('new')
  })
  finishInitial(snapshot('old'))
  await initialized
  expect(configuration.getProviderConfigurationState()).toEqual({
    snapshot: snapshot('new'),
    error: null,
  })
  expect(
    host.invoke.mock.calls.filter(([method]) => method === 'modelConfiguration.runtime')
  ).toHaveLength(1)
})

test('isolates a failed read and recovers through the existing retry without another subscription', async () => {
  const configuration = await import('./providerModelConfiguration')
  host.invoke.mockRejectedValue(new Error('Configuration is unreadable'))
  await expect(configuration.initializeProviderModelConfiguration()).resolves.toBeUndefined()
  expect(configuration.getProviderConfigurationState()).toEqual({
    snapshot: null,
    error: 'Configuration is unreadable',
  })

  host.invoke.mockImplementation(async method => {
    if (method === 'modelConfiguration.read') return snapshot('repaired')
    if (method === 'modelConfiguration.runtime') return { revision: 'repaired', models: [] }
    throw new Error(`Unexpected invocation: ${method}`)
  })
  await configuration.reloadProviderConfiguration()
  expect(configuration.getProviderConfigurationState()).toEqual({
    snapshot: snapshot('repaired'),
    error: null,
  })
  await configuration.initializeProviderModelConfiguration()
  expect(host.subscribe).toHaveBeenCalledTimes(1)
})
