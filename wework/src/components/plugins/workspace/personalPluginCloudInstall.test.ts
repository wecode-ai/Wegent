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
import { mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'
import { mergeInstalledPlugins } from '../installedPluginMerge'
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
  vi.unstubAllGlobals()
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

test.each([
  {
    visibility: 'personal',
    role: 'owner',
    sourceVersion: '1.1.0',
    localUpdateAvailable: false,
    updateAvailable: false,
  },
  {
    visibility: 'personal',
    role: 'owner',
    sourceVersion: '1.1.0',
    localUpdateAvailable: true,
    updateAvailable: true,
  },
  {
    visibility: 'personal',
    role: 'owner',
    sourceVersion: '1.2.0',
    localUpdateAvailable: false,
    updateAvailable: true,
  },
  {
    visibility: 'personal',
    role: 'recipient',
    sourceVersion: '1.1.0',
    localUpdateAvailable: false,
    updateAvailable: true,
  },
  {
    visibility: 'workspace',
    role: 'owner',
    sourceVersion: '1.1.0',
    localUpdateAvailable: false,
    updateAvailable: true,
  },
] as const)(
  'projects $visibility $role source $sourceVersion with local update=$localUpdateAvailable',
  ({ visibility, role, sourceVersion, localUpdateAvailable, updateAvailable }) => {
    const installed = {
      ...first,
      spec: {
        ...first.spec,
        origin: 'created' as const,
        version: '1.1.0',
        sourcePayload: { cloudPluginId: 17, marketplacePath: '/personal' },
      },
    }
    const account = {
      ...first,
      metadata: { ...first.metadata, namespace: 'default', labels: { id: '80' } },
      spec: {
        ...first.spec,
        pluginId: 17,
        releaseId: 117,
        version: '1.0.0',
      },
    }
    const [merged] = mergeMarketplaceCatalog(
      [
        {
          ...cloudRelease('first', 17),
          visibility,
          sourceProvider: 'user',
          accessRole: role,
          version: '1.0.0',
        },
      ],
      [
        item({
          id: 'first@wework-personal',
          name: 'first',
          version: sourceVersion,
          manifest: { marketplaceId: 'wework-personal', marketplacePath: '/personal' },
          installed: true,
          installedVersion: '1.1.0',
          updateAvailable: localUpdateAvailable,
        }),
      ],
      mergeInstalledPlugins([account], [installed], 'personal-sync-test', true)
    )

    expect(merged).toMatchObject({
      installed: true,
      installedVersion: '1.1.0',
      version: role === 'owner' ? sourceVersion : '1.0.0',
      updateAvailable,
    })
    if (role === 'owner') {
      expect(merged.sharedVersion).toBe('1.0.0')
      expect(merged.localPersonalSource).toEqual({
        pluginName: 'first',
        marketplacePath: '/personal',
      })
    } else expect(merged.localPersonalSource).toBeUndefined()
  }
)

test.each([false, true])(
  'reinstall restores the retained private release (linked: %s)',
  async linked => {
    const { schedule, local, onInstalled } = fixture()
    const plugin = linked
      ? { ...first, spec: { ...first.spec, sourcePayload: { cloudPluginId: 17 } } }
      : first
    const restored = { ...first, spec: { ...first.spec, pluginId: 17, releaseId: 117 } }
    mocks.list.mockResolvedValue({ items: [] })
    mocks.install.mockResolvedValue({ plugin: restored })
    if (!linked) {
      const archive = new JSZip()
      archive.file('.codex-plugin/plugin.json', JSON.stringify({ name: 'first', version: '1.0.0' }))
      local.packageCreatedPlugin.mockResolvedValue(
        new File([await archive.generateAsync({ type: 'arraybuffer' })], 'first.zip')
      )
      mocks.publish.mockRejectedValue(
        new ApiError('Reinstall the verified release', 409, 'PRIVATE_PLUGIN_REINSTALL_REQUIRED', {
          pluginId: 17,
          releaseId: 117,
        })
      )
    }

    schedule(plugin)
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())

    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(17, undefined, true)
    expect(local.linkPersonalPluginRelease).toHaveBeenCalledWith(
      plugin,
      17,
      117,
      expect.objectContaining({ accountInstall: 'updateRelease' })
    )
    if (linked) {
      expect(local.packageCreatedPlugin).not.toHaveBeenCalled()
      expect(mocks.publish).not.toHaveBeenCalled()
    } else {
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.any(File),
        expect.objectContaining({ privateFirstInstall: true, restoreDeleted: true }),
        expect.any(Function)
      )
    }
  }
)

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
  { source: 'author', switchesAccount: false, authFails: true, duringAuthorization: true },
  { source: 'author', switchesAccount: false, authFails: false, duringAuthorization: true },
  { source: 'author', switchesAccount: true, authFails: true, duringAuthorization: true },
] as const)(
  'settles a $source local commit after departure with account switch=$switchesAccount, auth failure=$authFails, and pending OAuth=$duringAuthorization',
  async ({ source, switchesAccount, authFails, duringAuthorization = false }) => {
    const { local, schedule, onInstalled } = fixture()
    const plugin = {
      ...first,
      spec: {
        ...first.spec,
        sourcePayload: { marketplacePath: '/personal' },
        components: {
          ...first.spec.components,
          connectors:
            authFails || duringAuthorization
              ? [{ slug: 'test-oauth', authPolicy: 'on_install' as const }]
              : [],
        },
      },
      status: { ...first.status, localExecution: true },
    }
    const committed = Promise.withResolvers<void>()
    const rollback = Promise.withResolvers<void>()
    const authorization = Promise.withResolvers<void>()
    const authorizing = vi.fn()
    let installedLocally = false
    const rollbackAfterAuthFailure = vi.fn(async (_plugin, isCurrent: () => boolean) => {
      if (isCurrent()) installedLocally = false
      await rollback.promise
    })
    const nativeInstall = vi.fn(
      async (onCommit?: (source: { pluginName: string; marketplacePath: string }) => void) => {
        await committed.promise
        installedLocally = true
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
          authorizing()
          if (duringAuthorization) await authorization.promise
          if (authFails) throw new Error('Authorization cancelled')
        },
        ensureLocalConnectorsAfterInstall: async () => {},
        rollbackInstalledPluginAfterAuthFailure: rollbackAfterAuthFailure,
        reconciliationBlocksActions: false,
        syncPersonalPluginInBackground: schedule,
      } as unknown as Parameters<typeof usePluginWorkspaceInstallation>[0])
    )
    act(() =>
      view.result.current.executeMarketplaceInstall({ item: listing, requiredConnectionNames: [] })
    )
    await vi.waitFor(() => expect(nativeInstall).toHaveBeenCalledOnce())
    if (duringAuthorization) {
      await act(async () => committed.resolve())
      await vi.waitFor(() => expect(authorizing).toHaveBeenCalledOnce())
    } else if (authFails) {
      await act(async () => committed.resolve())
      await vi.waitFor(() => expect(rollbackAfterAuthFailure).toHaveBeenCalledOnce())
    }
    view.unmount()
    detach()
    if (switchesAccount) saveStoredCloudConnection({ ...session, user: { ...session.user, id: 2 } })
    await act(async () => {
      committed.resolve()
      authorization.resolve()
      rollback.resolve()
    })
    if (switchesAccount || authFails || duringAuthorization) {
      if ((authFails || duringAuthorization) && !switchesAccount)
        await vi.waitFor(() => expect(installedLocally).toBe(false))
      expect(mocks.install).not.toHaveBeenCalled()
      expect(local.linkPersonalPluginRelease).not.toHaveBeenCalled()
      expect(installedLocally).toBe(switchesAccount)
    } else {
      await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())
      expect(mocks.install).toHaveBeenCalledExactlyOnceWith(17, undefined)
    }
  }
)

test.each([
  { phase: 'account', settled: false, failed: false },
  { phase: 'account', settled: true, failed: false },
  { phase: 'publication', settled: false, failed: false },
  { phase: 'publication', settled: true, failed: false },
  { phase: 'publication', settled: false, failed: true },
  { phase: 'account', settled: true, failed: false, omitCloudId: true },
])(
  'revalidates a local-only delete after $phase with already settled=$settled, failed=$failed, and omitted cloud id=$omitCloudId',
  async ({ phase, settled, failed, omitCloudId = false }) => {
    const { local, schedule, onInstalled } = fixture()
    const release = cloudRelease('first', 17)
    const write = Promise.withResolvers<void>()
    const completing = vi.fn()
    let published = phase === 'account'
    let installed = false
    let installedLocally = omitCloudId
    mocks.list.mockImplementation(async () => ({ items: published ? [release] : [] }))
    mocks.install.mockImplementation(async () => {
      if (phase === 'account') await write.promise
      installed = true
    })
    if (phase === 'publication') {
      const archive = new JSZip()
      archive.file('.codex-plugin/plugin.json', JSON.stringify({ name: 'first', version: '1.0.0' }))
      local.packageCreatedPlugin.mockResolvedValue(
        new File([await archive.generateAsync({ type: 'arraybuffer' })], 'first.zip')
      )
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
      const api = createPluginApi({
        post: async (path: string) => {
          if (path.endsWith('/init'))
            return {
              submissionId: 11,
              privateFirstInstall: true,
              uploadUrl: 'https://plugins.example/upload',
            }
          if (path.endsWith('/cancel')) return
          expect(path).toBe('/plugins/submissions/11/complete')
          completing()
          await write.promise
          if (failed) throw new ApiError('Publication failed', 503)
          published = true
          return {
            plugin: release,
            submission: { status: 'approved', releaseId: release.latestReleaseId },
          }
        },
      } as unknown as HttpClient)
      mocks.publish.mockImplementation(api.publishSubmission)
    }
    const deleteSource = vi.fn(() => expect(published).toBe(false))
    const impact = {
      pluginId: 17,
      impactRevision: 'current-revision',
      affectedUserCount: 0,
      installedDeviceCount: 1,
      sharedTargetCount: 0,
    }
    const deleteCloud = vi.fn(async () => {
      published = false
      installed = false
    })
    const view = renderHook(() =>
      usePluginWorkspaceDeletion({
        cloudMarketplaceAvailable: true,
        cloudToken: 'test-token',
        catalog: {
          captureScope: () => () => true,
          getSnapshot: () => ({ installedPlugins: [] }),
          showNotice: vi.fn(),
        },
        localPluginApi: {
          ...local,
          deletePersonalPlugin: deleteSource,
          uninstallInstalledPlugin: async () => {
            installedLocally = false
          },
        },
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
        ...(omitCloudId ? { installedId: 'local-first' } : { cloudPluginId: null }),
      })
    )
    schedule(first)
    await vi.waitFor(() =>
      expect(phase === 'account' ? mocks.install : completing).toHaveBeenCalledOnce()
    )
    if (settled) {
      write.resolve()
      await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())
    }
    let deletion: Promise<void> | undefined
    try {
      await act(async () => {
        deletion = view.result.current.confirmDeletePersonalPlugin()
      })
      expect(deleteSource).not.toHaveBeenCalled()
      expect(deleteCloud).not.toHaveBeenCalled()
      if (omitCloudId) expect(installedLocally).toBe(true)
    } finally {
      await act(async () => {
        write.resolve()
        await deletion
      })
    }
    if (failed) {
      expect(published).toBe(false)
      expect(installed).toBe(false)
      expect(deleteSource).toHaveBeenCalledOnce()
      expect(deleteCloud).not.toHaveBeenCalled()
      expect(view.result.current.pendingPersonalPluginDelete).toBeNull()
      return
    }
    expect(published).toBe(true)
    expect(installed).toBe(phase === 'account' || settled)
    expect(deleteSource).not.toHaveBeenCalled()
    if (omitCloudId) expect(installedLocally).toBe(true)
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
    expect(installedLocally).toBe(false)
  }
)

test.each([
  {
    scenario: 'source-only deletion',
    token: 'test-token',
    cloudPluginId: undefined,
    failed: false,
  },
  { scenario: 'signed-out deletion', token: null, cloudPluginId: null, failed: false },
  { scenario: 'no cloud version', token: 'test-token', cloudPluginId: null, failed: false },
  { scenario: 'unavailable catalog', token: 'test-token', cloudPluginId: null, failed: true },
])(
  'preserves existing deletion behavior for $scenario',
  async ({ token, cloudPluginId, failed }) => {
    mocks.list.mockResolvedValue({ items: [] })
    if (!token) mocks.list.mockRejectedValue(new ApiError('Not authenticated', 401))
    if (failed) mocks.list.mockRejectedValue(new Error('Catalog unavailable'))
    const deleteSource = vi.fn()
    const view = renderHook(() =>
      usePluginWorkspaceDeletion({
        cloudMarketplaceAvailable: true,
        cloudToken: token,
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
    expect(mocks.list).toHaveBeenCalledTimes(token ? 1 : 0)
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
