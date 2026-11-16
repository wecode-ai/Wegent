import { beforeEach, expect, test, vi } from 'vitest'
import { clearLocalCodexPluginsReadStateCache, createLocalCodexPluginApi } from './codexPlugins'
import { clearPluginMarketplaceCache } from '@/features/plugins/pluginMarketplaceCache'

const mocks = vi.hoisted(() => ({
  device: 'device-a',
  runtime: 'runtime-a',
  auth: 'auth-a',
  list: vi.fn(),
}))
vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('./runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: async () => ({ sha256: mocks.auth }),
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({
    deviceId: mocks.device,
    runtimeInstanceId: mocks.runtime,
  }),
  getKnownLocalExecutorDeviceId: () => mocks.device,
  withBundledPluginUpdatesPaused: (_name: string, action: () => Promise<unknown>) => action(),
  requestLocalExecutor: async (method: string, payload: { method?: string; params?: unknown }) => {
    if (method === 'codex.app_server_request' && payload.method === 'plugin/list')
      return mocks.list(payload.params)
    if (method === 'runtime.codex.plugin.uninstall_local') return { localCommitted: true }
    throw new Error(`Unexpected ${method}/${payload?.method}`)
  },
}))
const catalog = {
  marketplaces: [
    {
      name: 'openai-curated-remote',
      plugins: [
        {
          id: 'github',
          name: 'github',
          enabled: false,
          installed: false,
          installPolicy: 'NOT_AVAILABLE',
          authPolicy: 'ON_INSTALL',
          availability: 'DISABLED_BY_ADMIN',
          disabledReason: 'disabled_by_admin',
          eligiblePlanTypes: ['business'],
        },
      ],
    },
  ],
}
function deferred() {
  let resolve!: (value: typeof catalog) => void
  const promise = new Promise<typeof catalog>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const read = (accountScope = 'account-a', forceRefetch = false) =>
  createLocalCodexPluginApi().readRemoteCatalog({ accountScope, forceRefetch })
beforeEach(() => {
  clearLocalCodexPluginsReadStateCache()
  clearPluginMarketplaceCache()
  mocks.device = 'device-a'
  mocks.runtime = 'runtime-a'
  mocks.auth = 'auth-a'
  mocks.list.mockReset().mockResolvedValue(catalog)
})

test('eleven API adapters share a single official catalog request and retain policy metadata', async () => {
  const pending = deferred()
  mocks.list.mockReturnValueOnce(pending.promise)
  const readers = Array.from({ length: 11 }, () => read())
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  pending.resolve(catalog)
  const results = await Promise.all(readers)
  expect(results.every(result => result.items.length === 1)).toBe(true)
  expect(results[0].items[0].manifest).toMatchObject({
    installPolicy: 'NOT_AVAILABLE',
    authPolicy: 'ON_INSTALL',
    availability: 'DISABLED_BY_ADMIN',
    disabledReason: 'disabled_by_admin',
    eligiblePlanTypes: ['business'],
  })
  await read()
  expect(mocks.list).toHaveBeenCalledOnce()
})

test('local refresh and uninstall do not clear directory metadata or start a directory read', async () => {
  await read()
  clearLocalCodexPluginsReadStateCache()
  await read()
  await createLocalCodexPluginApi().uninstallInstalledPlugin('github@wework-personal')
  await read()
  expect(mocks.list).toHaveBeenCalledOnce()
})

test('manual refresh supersedes an ordinary read and concurrent manual readers join it', async () => {
  const ordinary = deferred()
  const forced = deferred()
  mocks.list.mockReturnValueOnce(ordinary.promise).mockReturnValueOnce(forced.promise)
  const stale = expect(read()).rejects.toThrow('scope changed')
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  const fresh = [read('account-a', true), read('account-a', true), read()]
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  ordinary.resolve(catalog)
  await stale
  forced.resolve({ marketplaces: [] })
  expect((await Promise.all(fresh)).every(result => result.items.length === 0)).toBe(true)
  expect(mocks.list.mock.calls.map(([params]) => params.forceRefetch)).toEqual([false, true])
})

test.each(['device', 'runtime', 'auth'] as const)(
  'never reuses or publishes the previous %s',
  async field => {
    const pending = deferred()
    mocks.list.mockReturnValueOnce(pending.promise)
    const stale = expect(read()).rejects.toThrow('scope changed')
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    const original = mocks[field]
    mocks[field] = 'replacement'
    await read()
    mocks[field] = original
    await read()
    pending.resolve(catalog)
    await stale
    expect(mocks.list).toHaveBeenCalledTimes(3)
  }
)

test('Wegent account changes and returning accounts cannot revive a pending old response', async () => {
  const pending = deferred()
  mocks.list.mockReturnValueOnce(pending.promise)
  const stale = expect(read()).rejects.toThrow('scope changed')
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  await read('account-b')
  await read('account-a')
  pending.resolve(catalog)
  await stale
  expect(mocks.list).toHaveBeenCalledTimes(3)
})

test('logout rejects late results even without a subsequent reader', async () => {
  const pending = deferred()
  mocks.list.mockReturnValueOnce(pending.promise)
  const stale = expect(read()).rejects.toThrow('scope changed')
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  clearPluginMarketplaceCache()
  pending.resolve(catalog)
  await stale
  await read()
  expect(mocks.list).toHaveBeenCalledTimes(2)
})

test('expired metadata revalidates only when read and failures never poison the cache', async () => {
  await read()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
  try {
    expect(mocks.list).toHaveBeenCalledOnce()
    mocks.list.mockRejectedValueOnce(new Error('offline'))
    await expect(read()).rejects.toThrow('offline')
    await read()
    expect(mocks.list).toHaveBeenCalledTimes(3)
  } finally {
    clock.mockRestore()
  }
})

test('a timed-out request is evicted and its late result cannot replace a successful retry', async () => {
  vi.useFakeTimers()
  const pending = deferred()
  mocks.list.mockReturnValueOnce(pending.promise)
  try {
    const timeout = expect(read()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.list).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    await timeout
    mocks.list.mockResolvedValueOnce({ marketplaces: [] })
    expect((await read()).items).toEqual([])
    pending.resolve(catalog)
    await vi.advanceTimersByTimeAsync(0)
    expect((await read()).items).toEqual([])
    expect(mocks.list).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test('an account switch before dispatch avoids sending the superseded catalog request', async () => {
  const stale = expect(read('account-a')).rejects.toThrow('scope changed')
  await read('account-b')
  await stale
  expect(mocks.list).toHaveBeenCalledOnce()
})
