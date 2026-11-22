import JSZip from 'jszip'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import { ApiError, type HttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import {
  clearStoredCloudConnection,
  saveStoredCloudConnection,
} from '@/features/cloud-connection/cloudConnectionStorage'
import { installedItem, item } from '@/features/plugins/pluginMarketplaceCache.test-fixtures'
import {
  cancelPersonalPluginCloudInstall,
  capturePersonalPluginCloudInstall,
} from './personalPluginCloudInstall'
import { createPluginCatalogState, type PluginCatalogInput } from './pluginCatalogState'
import { createPluginWorkspaceOperations } from './pluginWorkspaceOperations'
import { usePluginWorkspaceDeletion } from './usePluginWorkspaceDeletion'
import { usePluginWorkspaceInstallation } from './usePluginWorkspaceInstallation'

const mocks = vi.hoisted(() => ({
  device: 'personal-sync-test',
  list: vi.fn(),
  publish: vi.fn(),
  install: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/localExecutor')>()),
  getKnownLocalExecutorDeviceId: () => mocks.device,
  getInitializedBundledPluginMarketplace: () => ({ defaultPluginNames: ['bundled'] }),
}))

vi.mock('./marketplaceWorkspaceHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('./marketplaceWorkspaceHelpers')>()),
  createDefaultPluginApi: () => ({
    listMarketplacePlugins: mocks.list,
    publishSubmission: mocks.publish,
    installMarketplacePluginForAccount: mocks.install,
  }),
}))
vi.mock('./pluginCatalogRead', () => ({ loadPluginCatalog: () => () => undefined }))
vi.mock('./pluginCatalogLocalReconcile', () => ({ reconcileLocalPluginCatalog: () => undefined }))

const first = installedItem('local-first', 'wework-personal', 'first').raw
const second = installedItem('local-second', 'wework-personal', 'second').raw
const cloudRelease = (name: string, id: number) =>
  item({ id, name, visibility: 'personal', accessRole: 'owner', latestReleaseId: id + 100 })

const session = {
  backendUrl: 'https://plugins.example',
  apiBaseUrl: 'https://plugins.example/api',
  socketBaseUrl: 'https://plugins.example',
  socketPath: '/socket.io',
  user: { id: 1, user_name: 'author', email: 'author@example.com' },
  connectedAt: '2026-11-22T00:00:00.000Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  saveStoredCloudConnection(session)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  clearStoredCloudConnection()
  vi.restoreAllMocks()
})

function fixture() {
  const local = {
    listInstalledPlugins: vi.fn(),
    readInstalledPluginDetail: vi.fn().mockImplementation(async plugin => plugin),
    packageCreatedPlugin: vi.fn(),
    linkPersonalPluginRelease: vi.fn(),
  }
  const onInstalled = vi.fn()
  const schedule = capturePersonalPluginCloudInstall(local as unknown as LocalCodexPluginApi, {
    apiBaseUrl: session.apiBaseUrl,
    userId: session.user.id,
    getToken: () => 'test-token',
    onInstalled,
  })!
  return { local, schedule, onInstalled }
}

test('a pending or failed account install cannot delay another personal plugin', async () => {
  const { schedule, local, onInstalled } = fixture()
  const failing = Promise.withResolvers<void>()
  mocks.list.mockResolvedValue({ items: [cloudRelease('first', 17), cloudRelease('second', 18)] })
  mocks.install.mockImplementation((id: number) =>
    id === 17 ? failing.promise : Promise.resolve()
  )

  expect(schedule(first)).toBeUndefined()
  schedule(first)
  schedule(second)
  await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledExactlyOnceWith())
  expect(mocks.install.mock.calls).toEqual([
    [17, undefined],
    [18, undefined],
  ])
  expect(local.packageCreatedPlugin).not.toHaveBeenCalled()

  failing.reject(new ApiError('Account install failed', 503))
  await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
  expect(onInstalled).toHaveBeenCalledTimes(1)

  mocks.install.mockResolvedValue(undefined)
  schedule(first)
  await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(2))
  expect(mocks.install.mock.calls.map(([id]) => id)).toEqual([17, 18, 17])
})

test('first upload uses the exact packaged version and owner-only access', async () => {
  const { schedule, local, onInstalled } = fixture()
  const archive = new JSZip()
  archive.file('.codex-plugin/plugin.json', JSON.stringify({ name: 'first', version: '2.0.0' }))
  const file = new File([await archive.generateAsync({ type: 'arraybuffer' })], 'first.zip', {
    type: 'application/zip',
  })
  const release = cloudRelease('first', 17)
  local.packageCreatedPlugin.mockResolvedValue(file)
  mocks.list.mockResolvedValue({ items: [{ ...release, accessRole: 'recipient' }] })
  mocks.publish.mockResolvedValue({
    plugin: release,
    submission: { status: 'approved', releaseId: release.latestReleaseId },
  })

  schedule(first)
  await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())
  expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(
    file,
    expect.objectContaining({
      slug: 'first',
      version: '2.0.0',
      visibility: 'personal',
      targets: [],
      allowCopy: false,
      privateFirstInstall: true,
    }),
    expect.any(Function)
  )
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith(17, release.latestReleaseId)
})

test('a previous account link prevents first upload under a different account', async () => {
  const { schedule, local } = fixture()
  const linked = {
    ...first,
    spec: { ...first.spec, sourcePayload: { cloudPluginId: 45 } },
  }
  mocks.list.mockResolvedValue({ items: [cloudRelease('first', 17)] })
  schedule(linked)
  await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
  expect(local.packageCreatedPlugin).not.toHaveBeenCalled()
  expect(local.linkPersonalPluginRelease).not.toHaveBeenCalled()
  expect(mocks.install).not.toHaveBeenCalled()
})

test('removal waits for its own in-flight account record and cancels later work', async () => {
  const { schedule, local, onInstalled } = fixture()
  const write = Promise.withResolvers<void>()
  const secondLink = Promise.withResolvers<void>()
  mocks.list.mockResolvedValue({ items: [cloudRelease('first', 17), cloudRelease('second', 18)] })
  mocks.install.mockReturnValue(write.promise)
  local.linkPersonalPluginRelease.mockImplementation((_, id) =>
    id === 18 ? secondLink.promise : Promise.resolve()
  )

  schedule(first)
  schedule(second)
  await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce())
  const removedFirst = vi.fn()
  const firstRemoval = cancelPersonalPluginCloudInstall('first').then(removedFirst)
  const secondRemoval = cancelPersonalPluginCloudInstall('second')
  secondLink.resolve()
  await secondRemoval
  expect(removedFirst).not.toHaveBeenCalled()
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith(17, undefined)
  write.resolve()
  await firstRemoval
  expect(removedFirst).toHaveBeenCalledOnce()
  expect(onInstalled).not.toHaveBeenCalled()
})

test.each([
  { source: 'disk', switchesAccount: false, authFails: false },
  { source: 'author', switchesAccount: false, authFails: false },
  { source: 'disk', switchesAccount: true, authFails: false },
  { source: 'author', switchesAccount: true, authFails: false },
  { source: 'author', switchesAccount: false, authFails: true },
] as const)(
  'settles a $source local commit after departure with account switch=$switchesAccount and auth failure=$authFails',
  async ({ source, switchesAccount, authFails }) => {
    const { local, schedule, onInstalled } = fixture()
    const plugin = {
      ...first,
      spec: { ...first.spec, sourcePayload: { marketplacePath: '/personal' } },
    }
    const committed = Promise.withResolvers<void>()
    const rollback = Promise.withResolvers<void>()
    const rollbackAfterAuthFailure = vi.fn(() => rollback.promise)
    const nativeInstall = vi.fn(
      async (onCommit?: (source: { pluginName: string; marketplacePath: string }) => void) => {
        await committed.promise
        onCommit?.({ pluginName: 'first', marketplacePath: '/personal' })
        return plugin
      }
    )
    mocks.list.mockResolvedValue({ items: [cloudRelease('first', 17)] })
    local.listInstalledPlugins.mockResolvedValue({ items: [plugin] })
    const input = {
      knownExecutorDeviceId: mocks.device,
      cloudMarketplaceAvailable: false,
      t: (key: string) => key,
    } as unknown as PluginCatalogInput
    const catalog = createPluginCatalogState('personal-install/navigation', input)
    const detach = catalog.subscribe(input, () => {})
    const listing = item({
      ...cloudRelease('first', 17),
      id: source === 'author' ? 17 : 'first@wework-personal',
      manifest: { marketplaceId: 'wework-personal', marketplacePath: '/personal' },
      ...(source === 'author' && {
        localPersonalSource: { pluginName: 'first', marketplacePath: '/personal' },
      }),
    })
    const view = renderHook(() =>
      usePluginWorkspaceInstallation({
        catalog,
        operations: createPluginWorkspaceOperations('personal-install/navigation'),
        installedPlugins: [],
        localPluginApi: {
          ...local,
          readMarketplacePluginDetail: async () => plugin,
          installAvailablePlugin: (_item: unknown, onCommit: Parameters<typeof nativeInstall>[0]) =>
            nativeInstall(onCommit),
          installPersonalPluginSource: (
            _item: unknown,
            _isCurrent: unknown,
            onCommit: Parameters<typeof nativeInstall>[0]
          ) => nativeInstall(onCommit),
        },
        pluginApi: { getMarketplacePluginOwner: async () => ({ pluginId: 17 }) },
        t: (key: string) => key,
        selectedMarketplacePlugin: null,
        selectedMarketplacePluginDetail: null,
        isMarketplacePluginUninstalling: () => false,
        ensureMarketplaceConnectors: async () => {
          if (authFails) throw new Error('Authorization cancelled')
        },
        rollbackInstalledPluginAfterAuthFailure: rollbackAfterAuthFailure,
        reconciliationBlocksActions: false,
        syncPersonalPluginInBackground: schedule,
      } as unknown as Parameters<typeof usePluginWorkspaceInstallation>[0])
    )
    act(() =>
      view.result.current.executeMarketplaceInstall({ item: listing, requiredConnectionNames: [] })
    )
    await vi.waitFor(() => expect(nativeInstall).toHaveBeenCalledOnce())
    if (authFails) {
      await act(async () => committed.resolve())
      await vi.waitFor(() => expect(rollbackAfterAuthFailure).toHaveBeenCalledOnce())
    }
    view.unmount()
    detach()
    if (switchesAccount) saveStoredCloudConnection({ ...session, user: { ...session.user, id: 2 } })
    await act(async () => {
      committed.resolve()
      rollback.resolve()
    })
    if (switchesAccount || authFails) {
      expect(mocks.install).not.toHaveBeenCalled()
      expect(local.linkPersonalPluginRelease).not.toHaveBeenCalled()
    } else {
      await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())
      expect(mocks.install).toHaveBeenCalledExactlyOnceWith(17, undefined)
    }
  }
)

test.each([false, true])(
  'revalidates a local-only delete after its account write with already settled=%s',
  async settled => {
    const { local, schedule, onInstalled } = fixture()
    const release = cloudRelease('first', 17)
    const write = Promise.withResolvers<void>()
    let installed = false
    mocks.list.mockResolvedValue({ items: [release] })
    mocks.install.mockImplementation(async () => {
      await write.promise
      installed = true
    })
    const deleteSource = vi.fn()
    const impact = {
      pluginId: 17,
      impactRevision: 'current-revision',
      affectedUserCount: 0,
      installedDeviceCount: 1,
      sharedTargetCount: 0,
    }
    const deleteCloud = vi.fn(async () => {
      installed = false
    })
    const view = renderHook(() =>
      usePluginWorkspaceDeletion({
        cloudMarketplaceAvailable: true,
        catalog: {
          captureScope: () => () => true,
          getSnapshot: () => ({ installedPlugins: [] }),
          showNotice: vi.fn(),
        },
        localPluginApi: { ...local, deletePersonalPlugin: deleteSource },
        pluginApi: {
          listMarketplacePlugins: mocks.list,
          getMarketplacePluginDeleteImpact: async () => impact,
          deleteMarketplacePlugin: deleteCloud,
        },
        publications: {},
        publicationRequests: [],
        setSelectedPluginId: () => {},
        setSelectedMarketplacePluginId: () => {},
        refreshLocalMarketplace: () => {},
        t: (key: string) => key,
        marketplaceCacheKeyValue: 'personal-install/deletion',
      } as unknown as Parameters<typeof usePluginWorkspaceDeletion>[0])
    )
    await act(async () =>
      view.result.current.requestDeletePersonalPlugin({
        pluginName: 'first',
        displayName: 'First',
        cloudPluginId: null,
      })
    )
    schedule(first)
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce())
    if (settled) {
      write.resolve()
      await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())
    }
    await act(async () => {
      const deletion = view.result.current.confirmDeletePersonalPlugin()
      write.resolve()
      await deletion
    })
    expect(installed).toBe(true)
    expect(deleteSource).not.toHaveBeenCalled()
    expect(view.result.current.pendingPersonalPluginDelete).toMatchObject({
      cloudPluginId: 17,
      impact,
    })
    await act(async () => view.result.current.confirmDeletePersonalPlugin())
    expect(installed).toBe(false)
    expect(deleteCloud).toHaveBeenCalledExactlyOnceWith(17, {
      impactRevision: impact.impactRevision,
      revokeAndDelete: false,
    })
    expect(deleteSource).toHaveBeenCalledOnce()
  }
)

test.each([
  { scenario: 'source-only deletion', available: true, cloudPluginId: undefined, failed: false },
  { scenario: 'disconnected deletion', available: false, cloudPluginId: null, failed: false },
  { scenario: 'no cloud version', available: true, cloudPluginId: null, failed: false },
  { scenario: 'unavailable catalog', available: true, cloudPluginId: null, failed: true },
])(
  'preserves existing deletion behavior for $scenario',
  async ({ available, cloudPluginId, failed }) => {
    mocks.list.mockResolvedValue({ items: [] })
    if (failed) mocks.list.mockRejectedValue(new Error('Catalog unavailable'))
    const deleteSource = vi.fn()
    const view = renderHook(() =>
      usePluginWorkspaceDeletion({
        cloudMarketplaceAvailable: available,
        catalog: { captureScope: () => () => true, showNotice: vi.fn() },
        localPluginApi: { deletePersonalPlugin: deleteSource },
        pluginApi: { listMarketplacePlugins: mocks.list },
        publications: {},
        publicationRequests: [],
        setSelectedPluginId: () => {},
        setSelectedMarketplacePluginId: () => {},
        refreshLocalMarketplace: () => {},
        t: (key: string) => key,
        marketplaceCacheKeyValue: 'personal-install/local-delete',
      } as unknown as Parameters<typeof usePluginWorkspaceDeletion>[0])
    )
    await act(async () =>
      view.result.current.requestDeletePersonalPlugin({
        pluginName: 'first',
        displayName: 'First',
        cloudPluginId,
      })
    )
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => view.result.current.confirmDeletePersonalPlugin())
    expect(deleteSource).toHaveBeenCalledTimes(failed ? 0 : 1)
    expect(errorLog).toHaveBeenCalledTimes(failed ? 1 : 0)
    expect(mocks.list).toHaveBeenCalledTimes(available && cloudPluginId === null ? 1 : 0)
  }
)

test('a cloud account switch during upload prevents finalization', async () => {
  const put = Promise.withResolvers<Response>()
  const upload = vi.fn().mockReturnValue(put.promise)
  vi.stubGlobal('fetch', upload)
  try {
    const post = vi.fn().mockResolvedValue(undefined).mockResolvedValueOnce({
      submissionId: 11,
      privateFirstInstall: true,
      uploadUrl: 'https://plugins.example/upload',
    })
    const api = createPluginApi({ post } as unknown as HttpClient)
    let current = true
    const operation = api.publishSubmission(
      new File(['contents'], 'first.zip', { type: 'application/zip' }),
      { slug: 'first', displayName: 'First', version: '1.0.0', privateFirstInstall: true },
      () => {
        if (!current) throw new Error('Account changed')
      }
    )
    const failed = expect(operation).rejects.toThrow('Account changed')
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
    current = false
    put.resolve({ ok: true } as Response)
    await failed
    expect(post.mock.calls.map(([url]) => url)).toEqual([
      '/plugins/submissions/init',
      '/plugins/submissions/11/cancel',
    ])
  } finally {
    vi.unstubAllGlobals()
  }
})
