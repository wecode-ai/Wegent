import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import JSZip from 'jszip'
import { ApiError, type HttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  clearStoredCloudConnection,
  saveStoredCloudConnection,
  type StoredCloudConnection,
} from '@/features/cloud-connection/cloudConnectionStorage'
import { installedItem, item } from '@/features/plugins/pluginMarketplaceCache.test-fixtures'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  findMarketplaceItemForPluginReference,
  openMarketplacePluginDetailSelection,
  usePluginDetailSelection,
} from '../hooks/usePluginDetailSelection'
import { mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'
import { findPackableCreatedPlugin } from '../pluginOwnerLocalPackage'
import { uninstallAccountPlugin, uninstallPluginIdentities } from '../pluginUninstall'
import {
  personalPluginDiskSource,
  personalPluginInstallSource,
} from './personalPluginInstallSource'
import { usePersonalPluginAccountInstall } from './usePersonalPluginAccountInstall'
import { usePluginWorkspaceDeletion } from './usePluginWorkspaceDeletion'
import { usePluginWorkspacePublishing } from './usePluginWorkspacePublishing'

const localSource = installedItem('local-owner', 'wework-personal', 'my-plugin')
const release = item({
  id: 17,
  name: localSource.name,
  visibility: 'personal',
  accessRole: 'owner',
  latestReleaseId: 42,
})
const cloudConnection: StoredCloudConnection = {
  backendUrl: 'https://wegent.example',
  apiBaseUrl: 'https://wegent.example/api',
  socketBaseUrl: 'https://wegent.example',
  socketPath: '/socket.io',
  user: { id: 1, user_name: 'author', email: 'author@example.com' },
  connectedAt: '2026-11-20T00:00:00.000Z',
}
const accountIdentity = { apiBaseUrl: cloudConnection.apiBaseUrl, userId: cloudConnection.user.id }

beforeEach(() => saveStoredCloudConnection(cloudConnection))
afterEach(clearStoredCloudConnection)

interface AuthorDetailFixture {
  plugin?: typeof localSource
  diskListing?: PluginMarketplaceItem
  listings?: PluginMarketplaceItem[]
  listMarketplacePlugins?: () => Promise<{ items: PluginMarketplaceItem[] }>
  publishPrivate?: () => Promise<{ pluginId: number; releaseId: number }>
  linkSource?: Parameters<typeof usePersonalPluginAccountInstall>[0]['linkSource']
  secondPlugin?: typeof localSource
  localInstall?: () => Promise<void>
}

function renderAuthorDetail({
  plugin = localSource,
  diskListing,
  listings = [],
  listMarketplacePlugins = async () => ({ items: listings }),
  publishPrivate = vi.fn(async () => ({ pluginId: 17, releaseId: 42 })),
  linkSource = async () => {},
  secondPlugin,
  localInstall,
}: AuthorDetailFixture = {}) {
  const api = {
    listMarketplacePlugins,
    installMarketplacePluginForAccount: vi.fn().mockResolvedValue({ plugin: localSource.raw }),
  }
  let mounted = true
  const detachListeners = new Set<() => void>()
  const catalog = {
    captureScope: () => () => mounted,
    onDetach(listener: () => void) {
      detachListeners.add(listener)
      return () => {
        detachListeners.delete(listener)
      }
    },
    dismissNotice: vi.fn(),
    refresh: vi.fn(),
    showNotice: vi.fn(),
  }
  const source = diskListing
    ? personalPluginInstallSource([], diskListing)
    : personalPluginInstallSource([plugin])

  function AuthorDetail() {
    const { t } = useTranslation('common')
    const [detailSourceKey, setDetailSourceKey] = useState(source?.key ?? null)
    const install = usePersonalPluginAccountInstall({
      accountIdentity,
      available: true,
      api,
      catalog,
      detailSourceKey,
      preparePrivate: async () => ({ plugin, file: new File([], 'plugin.zip'), version: '1.0.0' }),
      publishPrivate,
      linkSource,
      t,
    })
    const action = install.actionFor(source)
    return (
      <>
        <button onClick={() => setDetailSourceKey(null)}>Close detail</button>
        <button onClick={install.refreshAccountCatalog}>Refresh</button>
        {action && (
          <button disabled={install.busy} onClick={action}>
            Install
          </button>
        )}
        {localInstall && (
          <button
            onClick={async () => {
              const request = source ? install.reserveInstallRequest(source.key) : undefined
              if (request === null) return
              try {
                await localInstall()
                request?.submit(source)
              } finally {
                request?.release()
              }
            }}
          >
            Install locally
          </button>
        )}
        {secondPlugin && (
          <button
            onClick={() =>
              install.requestInstall(
                personalPluginDiskSource(secondPlugin.name, secondPlugin.name, '/personal')
              )
            }
          >
            Install another plugin
          </button>
        )}
        {install.dialog}
      </>
    )
  }

  const view = render(<AuthorDetail />)
  return {
    api,
    catalog,
    publishPrivate,
    leavePluginWorkspace() {
      mounted = false
      view.unmount()
      for (const listener of detachListeners) listener()
    },
  }
}

test('retries a failed account install using the already uploaded personal release', async () => {
  let uploaded = false
  const { api, catalog, publishPrivate } = renderAuthorDetail({
    listMarketplacePlugins: async () => ({ items: uploaded ? [release] : [] }),
    publishPrivate: vi.fn(async () => {
      uploaded = true
      return { pluginId: 17, releaseId: 42 }
    }),
  })
  api.installMarketplacePluginForAccount.mockRejectedValueOnce(new Error('Account write failed'))
  const install = await screen.findByRole('button', { name: 'Install' })
  fireEvent.click(install)
  const confirm = await screen.findByTestId('personal-plugin-install-private-confirm')
  expect(uploaded).toBe(false)
  fireEvent.click(confirm)
  await waitFor(() =>
    expect(catalog.showNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'error', message: 'Account write failed' })
    )
  )
  expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17, 42)
  fireEvent.click(install)
  await waitFor(() =>
    expect(catalog.showNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'success' })
    )
  )
  expect(screen.queryByTestId('personal-plugin-install-private-dialog')).not.toBeInTheDocument()
  expect(publishPrivate).toHaveBeenCalledTimes(1)
  expect(api.installMarketplacePluginForAccount).toHaveBeenLastCalledWith(17)
})

test('retries the source link before installing an already published private release', async () => {
  let uploaded = false
  const linkSource = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('Failed to save the source link'))
    .mockResolvedValue(undefined)
  const { api, catalog, publishPrivate } = renderAuthorDetail({
    listMarketplacePlugins: async () => ({ items: uploaded ? [release] : [] }),
    publishPrivate: vi.fn(async () => {
      uploaded = true
      return { pluginId: 17, releaseId: 42 }
    }),
    linkSource,
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  fireEvent.click(await screen.findByTestId('personal-plugin-install-private-confirm'))
  await waitFor(() =>
    expect(catalog.showNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'error', message: 'Failed to save the source link' })
    )
  )
  expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17)
  )
  expect(publishPrivate).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('personal-plugin-install-private-dialog')).not.toBeInTheDocument()
})

test('installs a second personal source without an open detail after the first upload is cancelled', async () => {
  const secondPlugin = installedItem('local-second', 'wework-personal', 'other-plugin')
  const { api, publishPrivate } = renderAuthorDetail({
    secondPlugin,
    listings: [{ ...release, id: 18, name: secondPlugin.name }],
  })
  const closeDetail = screen.getByRole('button', { name: 'Close detail' })
  const installAnother = screen.getByRole('button', { name: 'Install another plugin' })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  const cancel = await screen.findByTestId('personal-plugin-install-private-cancel')
  fireEvent.click(closeDetail)
  fireEvent.click(installAnother)
  expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
  fireEvent.click(cancel)
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(18)
  )
  expect(publishPrivate).not.toHaveBeenCalled()
  expect(screen.queryByTestId('personal-plugin-install-private-dialog')).not.toBeInTheDocument()
})

test('reports a conflicting link after resolving the current account’s owned release', async () => {
  const plugin = installedItem('local-owner', 'wework-personal', 'my-plugin')
  plugin.raw.spec.sourcePayload = { cloudPluginId: 17, cloudInstalledPluginId: 120 }
  const linkSource = vi.fn().mockRejectedValue(new Error('PLUGIN_PERSONAL_SOURCE_LINK_CONFLICT'))
  const { api, catalog, publishPrivate } = renderAuthorDetail({
    plugin,
    linkSource,
    listings: [
      { ...release, name: 'different-plugin', installedPluginId: 120 },
      { ...release, id: 18, accessRole: 'recipient' },
      { ...release, id: 19 },
    ],
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  await waitFor(() =>
    expect(catalog.showNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  )
  expect(linkSource).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source: expect.objectContaining({ installed: plugin }) }),
    { pluginId: 19, releaseId: 42 },
    undefined
  )
  expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
  expect(publishPrivate).not.toHaveBeenCalled()
})

test('blocks uninstall through local completion and account install after navigation', async () => {
  const plugin = installedItem('local-owner', 'wework-personal', 'my-plugin')
  plugin.raw.spec.sourcePayload = { cloudPluginId: 17, cloudReleaseId: 42 }
  const local = Promise.withResolvers<void>()
  const install = Promise.withResolvers<{ plugin: typeof localSource.raw }>()
  const { api, leavePluginWorkspace } = renderAuthorDetail({
    plugin,
    listings: [release],
    localInstall: () => local.promise,
  })
  api.installMarketplacePluginForAccount.mockReturnValue(install.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Install locally' }))
  const accountInstall = {
    ...plugin.raw,
    metadata: { ...plugin.raw.metadata, labels: { id: 120 } },
    spec: { ...plugin.raw.spec, pluginId: 17 },
  }
  const uninstall = {
    personalSourceKey: 'my-plugin',
    isCurrent: () => true,
    readLocalInstalled: vi.fn().mockResolvedValue({ items: [plugin.raw] }),
    readCloudInstalled: vi.fn().mockResolvedValue({ items: [] }),
    uninstallCloud: vi.fn().mockResolvedValue(undefined),
    uninstallLocal: vi.fn().mockResolvedValue(undefined),
    logoutLocal: vi.fn().mockResolvedValue(undefined),
  }
  try {
    leavePluginWorkspace()
    await expect(
      uninstallPluginIdentities(plugin.raw, plugin.id, undefined, uninstall)
    ).rejects.toThrow('PLUGIN_PERSONAL_MUTATION_IN_PROGRESS')
    expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
    await act(async () => local.resolve())
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17)
    await expect(uninstallAccountPlugin(17, undefined, uninstall)).rejects.toThrow(
      'PLUGIN_PERSONAL_MUTATION_IN_PROGRESS'
    )
    expect(uninstall.readCloudInstalled).not.toHaveBeenCalled()
    expect(uninstall.uninstallLocal).not.toHaveBeenCalled()
  } finally {
    await act(async () => {
      local.resolve()
      install.resolve({ plugin: accountInstall })
    })
  }
  uninstall.readCloudInstalled.mockResolvedValue({ items: [accountInstall] })
  await uninstallPluginIdentities(plugin.raw, plugin.id, undefined, uninstall)
  expect(uninstall.uninstallCloud).toHaveBeenCalledExactlyOnceWith(120, undefined)
  expect(uninstall.uninstallLocal).toHaveBeenCalledExactlyOnceWith(plugin.id)
})

test('offers installation for an editable source that is present on disk only', async () => {
  const { api } = renderAuthorDetail({
    diskListing: item({
      id: 'personal-disk:my-plugin',
      name: localSource.name,
      visibility: 'personal',
      manifest: { marketplaceId: 'wework-personal', marketplacePath: '/personal' },
    }),
    listings: [release],
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17)
  )
})

test('keeps the disk-only detail open when private publication replaces the catalog row', () => {
  const diskListing = item({
    id: 'personal-disk:my-plugin',
    name: localSource.name,
    visibility: 'personal',
    manifest: { marketplaceId: 'wework-personal', marketplacePath: '/personal' },
  })
  const recipientListing = { ...release, id: 19, accessRole: 'recipient' as const }
  const ownedListing = {
    ...release,
    localPersonalSource: { pluginName: localSource.name, marketplacePath: '/personal' },
  }
  const { result, rerender } = renderHook(
    ({ items }: { items: PluginMarketplaceItem[] }) => {
      const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
        string | number | null
      >(null)
      const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
      const detail = usePluginDetailSelection({
        scopeKey: 'account',
        pluginReference: null,
        pluginMarketplaceState: { items, isLoading: false, error: null },
        installedPlugins: [],
        selectedPluginId,
        selectedMarketplacePluginId,
        setSelectedPluginId,
        setSelectedMarketplacePluginId,
      })
      return { selected: detail.selectedMarketplacePlugin, setSelectedMarketplacePluginId }
    },
    { initialProps: { items: [diskListing] } }
  )

  act(() => result.current.setSelectedMarketplacePluginId(diskListing.id))
  expect(result.current.selected).toBe(diskListing)
  rerender({ items: [recipientListing, ownedListing] })
  expect(result.current.selected).toBe(ownedListing)
})

test('installs the existing release when the server rejects a concurrent first upload', async () => {
  let shared = false
  const { api, publishPrivate } = renderAuthorDetail({
    listMarketplacePlugins: async () => ({ items: shared ? [release] : [] }),
    publishPrivate: vi.fn(async () => {
      shared = true
      throw new ApiError('Sharing completed', 409, 'PRIVATE_FIRST_INSTALL_CONFLICT')
    }),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  fireEvent.click(await screen.findByTestId('personal-plugin-install-private-confirm'))
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17)
  )
  expect(publishPrivate).toHaveBeenCalledTimes(1)
})

test('keeps a disk-only author source separate from a same-name recipient listing', () => {
  const recipient = { ...release, accessRole: 'recipient' as const, ownerUserId: 99 }
  const disk = item({
    id: 'personal-disk:my-plugin',
    name: localSource.name,
    visibility: 'personal',
    manifest: { marketplaceId: 'wework-personal', marketplacePath: '/personal' },
  })
  const combined = mergeMarketplaceCatalog([recipient], [disk], [])
  expect(combined.map(item => item.id)).toEqual([recipient.id, disk.id])
  expect(
    findMarketplaceItemForPluginReference(combined, {
      pluginName: disk.name,
      marketplaceName: 'wework-personal',
    })?.id
  ).toBe(disk.id)
  expect(personalPluginInstallSource([], recipient)).toBeNull()
})

test('opening a cloud detail does not select unrelated local source via a stale link', () => {
  const local = installedItem('local-owner', 'wework-personal', 'my-plugin')
  local.raw.spec.sourcePayload = { cloudPluginId: 17 }
  const other = {
    ...release,
    name: 'different-plugin',
    displayName: 'Different Plugin',
    installedPluginId: local.id,
  }
  const setSelectedPluginId = vi.fn()
  const setSelectedMarketplacePluginId = vi.fn()
  openMarketplacePluginDetailSelection({
    item: other,
    installedPlugins: [local],
    findPackableCreatedPlugin,
    setSelectedPluginId,
    setSelectedMarketplacePluginId,
  })
  expect(setSelectedPluginId).toHaveBeenCalledExactlyOnceWith(null)
  expect(setSelectedMarketplacePluginId).toHaveBeenCalledExactlyOnceWith(other.id)
})

test('links the exact imported private release before account install after leaving plugins', async () => {
  const installed = installedItem('local-owner', 'wework-personal', 'my-plugin')
  installed.version = '1.0.0'
  installed.raw.spec.version = '1.0.0'
  const archive = new JSZip()
  archive.file('.codex-plugin/plugin.json', JSON.stringify({ name: 'my-plugin', version: '1.1.0' }))
  const file = new File([await archive.generateAsync({ type: 'arraybuffer' })], 'my-plugin.zip')
  const packageCreatedPlugin = vi.fn().mockResolvedValue(file)
  const upload = Promise.withResolvers<{
    submission: { status: string; releaseId: number }
    plugin: PluginMarketplaceItem
  }>()
  const publishSubmission = vi.fn(() => upload.promise)
  const link = Promise.withResolvers<void>()
  const linkPersonalPluginRelease = vi.fn(() => link.promise)
  const installMarketplacePluginForAccount = vi.fn().mockResolvedValue({ plugin: installed.raw })
  const source = personalPluginDiskSource('my-plugin', 'My plugin', '/personal')
  let mounted = true
  const catalog = {
    captureScope: () => () => mounted,
    onDetach: () => () => {},
    dismissNotice: vi.fn(),
    refresh: vi.fn(),
    reportError: vi.fn(),
    showNotice: vi.fn(),
  }

  const publishingInput = {
    catalog,
    setSelectedMarketplacePluginId: vi.fn(),
    setSelectedPluginId: vi.fn(),
    pluginApi: { listPublicationRequests: async () => ({ items: [] }), publishSubmission },
    accountPluginApi: {
      listMarketplacePlugins: async () => ({ items: [] }),
      installMarketplacePluginForAccount,
    },
    accountIdentity,
    canInstallForAccount: true,
    personalDetailSourceKey: installed.raw.spec.source.pluginKey,
    localPluginApi: {
      packageCreatedPlugin,
      linkPersonalPluginRelease,
      readMarketplacePluginDetail: async () => installed.raw,
    },
    installedPlugins: [],
    pluginMarketplaceState: { items: [], isLoading: false, error: null },
    marketplaceCacheKeyValue: 'active-account',
  } as unknown as Omit<Parameters<typeof usePluginWorkspacePublishing>[0], 't'>

  function Author() {
    const { t } = useTranslation('common')
    const { personalInstallation } = usePluginWorkspacePublishing({ ...publishingInput, t })
    return (
      <>
        <button onClick={() => personalInstallation.requestInstall(source)}>Install</button>
        {personalInstallation.dialog}
      </>
    )
  }

  const view = render(<Author />)
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  const confirm = await screen.findByTestId('personal-plugin-install-private-confirm')
  expect(screen.getByTestId('personal-plugin-install-private-dialog')).toHaveTextContent('1.1.0')
  expect(publishSubmission).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  await waitFor(() =>
    expect(publishSubmission).toHaveBeenCalledExactlyOnceWith(
      file,
      expect.objectContaining({ version: '1.1.0', privateFirstInstall: true })
    )
  )
  expect(packageCreatedPlugin).toHaveBeenCalledTimes(1)
  mounted = false
  view.unmount()
  await act(async () =>
    upload.resolve({ submission: { status: 'approved', releaseId: 42 }, plugin: release })
  )
  expect(linkPersonalPluginRelease).toHaveBeenCalledExactlyOnceWith(
    installed.raw,
    17,
    42,
    expect.objectContaining({ accountInstall: 'updateRelease' })
  )
  expect(installMarketplacePluginForAccount).not.toHaveBeenCalled()
  await act(async () => link.resolve())
  expect(installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17, 42)
})

test('sends no artifact when the server did not acknowledge the private first-install guard', async () => {
  const post = vi
    .fn()
    .mockResolvedValueOnce({ submissionId: 1, uploadUrl: '/artifact' })
    .mockResolvedValue(undefined)
  const upload = vi.spyOn(globalThis, 'fetch')
  try {
    const api = createPluginApi({ post } as unknown as HttpClient)
    const file = new File(['package'], 'plugin.zip')
    await expect(
      api.publishSubmission(file, {
        slug: 'my-plugin',
        displayName: 'My plugin',
        version: '1.1.0',
        privateFirstInstall: true,
      })
    ).rejects.toThrow('The server did not confirm first private plugin publication')
    expect(upload).not.toHaveBeenCalled()
    expect(post).toHaveBeenLastCalledWith('/plugins/submissions/1/cancel')
  } finally {
    upload.mockRestore()
  }
})

test.each(['ready', 'failed'])(
  'keeps account install hidden while the initial catalog read is pending and then %s',
  async outcome => {
    const read = Promise.withResolvers<{ items: PluginMarketplaceItem[] }>()
    const { api } = renderAuthorDetail({ listMarketplacePlugins: () => read.promise })
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    await act(async () => {
      if (outcome === 'failed') read.reject(new Error('Catalog unavailable'))
      else read.resolve({ items: [{ ...release, installedPluginId: 120 }] })
    })
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
  }
)

test('recovers the install action when a manual refresh confirms missing account membership', async () => {
  const listMarketplacePlugins = vi
    .fn<() => Promise<{ items: PluginMarketplaceItem[] }>>()
    .mockRejectedValueOnce(new Error('Catalog unavailable'))
    .mockResolvedValue({ items: [release] })
  const { api } = renderAuthorDetail({ listMarketplacePlugins })
  await waitFor(() => expect(listMarketplacePlugins).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17)
  )
})

test.each([
  {
    scenario: 'same account with a release',
    session: cloudConnection,
    listings: [release],
    installs: true,
  },
  {
    scenario: 'same account without a release',
    session: cloudConnection,
    listings: [],
    installs: false,
  },
  { scenario: 'signed out', session: null, listings: [release], installs: false },
  {
    scenario: 'switched accounts',
    session: { ...cloudConnection, user: { ...cloudConnection.user, id: 2 } },
    listings: [release],
    installs: false,
  },
  {
    scenario: 'signed in again',
    session: { ...cloudConnection, connectedAt: '2026-11-20T01:00:00.000Z' },
    listings: [release],
    installs: false,
  },
])(
  'handles local completion after leaving plugins for $scenario',
  async ({ session, listings, installs }) => {
    const local = Promise.withResolvers<void>()
    const { api, catalog, leavePluginWorkspace, publishPrivate } = renderAuthorDetail({
      listings,
      localInstall: () => local.promise,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Install locally' }))
    expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
    leavePluginWorkspace()
    if (session) saveStoredCloudConnection(session)
    else clearStoredCloudConnection()
    await act(async () => local.resolve())
    if (installs) expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17)
    else expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
    expect(publishPrivate).not.toHaveBeenCalled()
    expect(catalog.showNotice).not.toHaveBeenCalled()
  }
)

test('continues a queued existing release when leaving an unconfirmed private upload', async () => {
  const secondPlugin = installedItem('local-second', 'wework-personal', 'other-plugin')
  const { api, leavePluginWorkspace, publishPrivate } = renderAuthorDetail({
    secondPlugin,
    listings: [{ ...release, id: 18, name: secondPlugin.name }],
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  await screen.findByTestId('personal-plugin-install-private-confirm')
  fireEvent.click(screen.getByRole('button', { name: 'Install another plugin' }))
  expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
  leavePluginWorkspace()
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(18)
  )
  expect(publishPrivate).not.toHaveBeenCalled()
})

test('a confirmed upload still installs for the account when the detail is closed', async () => {
  let finishUpload: (release: { pluginId: number; releaseId: number }) => void
  const upload = new Promise<{ pluginId: number; releaseId: number }>(resolve => {
    finishUpload = resolve
  })
  const { api, publishPrivate } = renderAuthorDetail({ publishPrivate: vi.fn(() => upload) })
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
  fireEvent.click(await screen.findByTestId('personal-plugin-install-private-confirm'))
  await waitFor(() => expect(publishPrivate).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Close detail' }))
  await act(async () => finishUpload({ pluginId: 17, releaseId: 42 }))
  expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17, 42)
})

test('deleting a separate personal row leaves the cloud plugin and its publication alone', async () => {
  const disk = item({
    id: 'personal-disk:demo-tool',
    name: 'demo-tool',
    visibility: 'personal',
    manifest: { marketplaceId: 'wework-personal', marketplacePath: '/personal' },
  })
  const cloud = { ...release, name: 'Demo Tool' }
  expect(mergeMarketplaceCatalog([cloud], [disk], []).map(row => row.id)).toEqual([
    cloud.id,
    disk.id,
  ])
  const deletePersonalPlugin = vi.fn().mockResolvedValue(undefined)
  const deleteMarketplacePlugin = vi.fn()
  const withdrawPublicationRequest = vi.fn()
  const getMarketplacePluginDeleteImpact = vi.fn().mockResolvedValue({ pluginId: cloud.id })
  const deletionInput = {
    catalog: { captureScope: () => () => true, showNotice: vi.fn() },
    publicationRequests: [
      {
        id: 21,
        pluginId: cloud.id,
        pluginSlug: disk.name,
        status: 'awaiting_admin',
        currentRevision: 1,
        actionEligibility: { canWithdraw: true },
      },
    ],
    accountPluginApi: { listMarketplacePlugins: async () => ({ items: [cloud] }) },
    pluginApi: {
      deleteMarketplacePlugin,
      getMarketplacePluginDeleteImpact,
      withdrawPublicationRequest,
    },
    localPluginApi: { deletePersonalPlugin },
    marketplaceCacheKeyValue: 'separate-personal-delete',
    setSelectedPluginId: vi.fn(),
    setSelectedMarketplacePluginId: vi.fn(),
    refreshLocalMarketplace: vi.fn(),
  } as unknown as Omit<Parameters<typeof usePluginWorkspaceDeletion>[0], 't'>
  const { result } = renderHook(() => {
    const { t } = useTranslation('common')
    return usePluginWorkspaceDeletion({ ...deletionInput, t })
  })
  await act(() =>
    result.current.requestDeletePersonalPlugin({
      pluginName: disk.name,
      displayName: disk.displayName,
      marketplacePath: '/personal',
      cloudPluginId: null,
    })
  )
  expect.soft(result.current.pendingPersonalPluginDelete?.publication).toBeNull()
  await act(() => result.current.confirmDeletePersonalPlugin())

  expect.soft(getMarketplacePluginDeleteImpact).not.toHaveBeenCalled()
  expect(deleteMarketplacePlugin).not.toHaveBeenCalled()
  expect(withdrawPublicationRequest).not.toHaveBeenCalled()
  expect(deletePersonalPlugin).toHaveBeenCalledExactlyOnceWith(disk.name, '/personal')
})

test.each(['before', 'during', 'after'] as const)(
  'rejects stale personal deletion requested %s the first upload',
  async when => {
    const upload = Promise.withResolvers<{ pluginId: number; releaseId: number }>()
    const { api, catalog, publishPrivate } = renderAuthorDetail({
      publishPrivate: vi.fn(() => upload.promise),
    })
    const deletePersonalPlugin = vi.fn().mockResolvedValue(undefined)
    const deleteMarketplacePlugin = vi.fn().mockResolvedValue(undefined)
    const listMarketplacePlugins = vi.fn().mockResolvedValue({
      items: [{ ...release, id: 18, accessRole: 'recipient' }, release],
    })
    const getMarketplacePluginDeleteImpact = vi.fn().mockResolvedValue({
      pluginId: 17,
      affectedUserCount: 0,
      installedDeviceCount: 1,
      sharedTargetCount: 0,
      impactRevision: 'latest-impact',
    })
    const deletionInput = {
      catalog,
      publicationRequests: [],
      accountPluginApi: { listMarketplacePlugins },
      pluginApi: { deleteMarketplacePlugin, getMarketplacePluginDeleteImpact },
      localPluginApi: { deletePersonalPlugin },
      marketplaceCacheKeyValue: 'personal-delete',
      setSelectedPluginId: vi.fn(),
      setSelectedMarketplacePluginId: vi.fn(),
      refreshLocalMarketplace: vi.fn(),
    } as unknown as Omit<Parameters<typeof usePluginWorkspaceDeletion>[0], 't'>
    const { result } = renderHook(() => {
      const { t } = useTranslation('common')
      return usePluginWorkspaceDeletion({ ...deletionInput, t })
    })
    const requestDelete = (cloudPluginId?: number | null) =>
      act(() =>
        result.current.requestDeletePersonalPlugin({
          pluginName: localSource.raw.spec.source.pluginKey,
          displayName: localSource.name,
          marketplacePath: '/personal',
          cloudPluginId,
        })
      )
    const confirmDelete = () => act(() => result.current.confirmDeletePersonalPlugin())

    if (when === 'before') await requestDelete()
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    fireEvent.click(await screen.findByTestId('personal-plugin-install-private-confirm'))
    try {
      await waitFor(() => expect(publishPrivate).toHaveBeenCalledTimes(1))
      if (when !== 'after') {
        if (when === 'before') await confirmDelete()
        else await requestDelete()
        expect(result.current.pendingPersonalPluginDelete).toBeNull()
        expect(catalog.showNotice).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: 'personal-plugin-mutation-in-progress', kind: 'error' })
        )
      }
    } finally {
      await act(async () => upload.resolve({ pluginId: 17, releaseId: 42 }))
    }
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17, 42)
    if (when === 'after') await requestDelete(null)
    await confirmDelete()
    expect(deletePersonalPlugin).not.toHaveBeenCalled()
    expect(deleteMarketplacePlugin).not.toHaveBeenCalled()

    if (when === 'after') {
      expect(result.current.pendingPersonalPluginDelete?.cloudPluginId).toBe(17)
    } else {
      await requestDelete(17)
    }
    expect(getMarketplacePluginDeleteImpact).toHaveBeenCalledExactlyOnceWith(17)
    await confirmDelete()
    expect(deleteMarketplacePlugin).toHaveBeenCalledExactlyOnceWith(17, {
      impactRevision: 'latest-impact',
      revokeAndDelete: false,
    })
    expect(deletePersonalPlugin).toHaveBeenCalledExactlyOnceWith('my-plugin', '/personal')
  }
)

test.each([
  { session: 'unchanged', next: cloudConnection, installs: true },
  { session: 'signed out', next: null, installs: false },
  {
    session: 'switched accounts',
    next: { ...cloudConnection, user: { ...cloudConnection.user, id: 2 } },
    installs: false,
  },
])(
  'a confirmed upload follows the $session session after leaving plugins',
  async ({ next, installs }) => {
    let finishUpload: (release: { pluginId: number; releaseId: number }) => void
    const upload = new Promise<{ pluginId: number; releaseId: number }>(resolve => {
      finishUpload = resolve
    })
    const { api, catalog, leavePluginWorkspace, publishPrivate } = renderAuthorDetail({
      publishPrivate: vi.fn(() => upload),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    fireEvent.click(await screen.findByTestId('personal-plugin-install-private-confirm'))
    await waitFor(() => expect(publishPrivate).toHaveBeenCalledTimes(1))
    leavePluginWorkspace()
    if (next) saveStoredCloudConnection(next)
    else clearStoredCloudConnection()
    await act(async () => finishUpload({ pluginId: 17, releaseId: 42 }))

    if (installs)
      expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17, 42)
    else expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
    expect(catalog.showNotice).not.toHaveBeenCalled()
  }
)
