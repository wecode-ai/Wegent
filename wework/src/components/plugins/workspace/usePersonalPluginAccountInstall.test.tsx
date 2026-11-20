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
import { personalPluginInstallSource } from './personalPluginInstallSource'
import { usePersonalPluginAccountInstall } from './usePersonalPluginAccountInstall'
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
}

function renderAuthorDetail({
  plugin = localSource,
  diskListing,
  listings = [],
  listMarketplacePlugins = async () => ({ items: listings }),
  publishPrivate = vi.fn(async () => ({ pluginId: 17, releaseId: 42 })),
}: AuthorDetailFixture = {}) {
  const api = {
    listMarketplacePlugins,
    installMarketplacePluginForAccount: vi.fn().mockResolvedValue({ plugin: localSource.raw }),
  }
  let mounted = true
  const catalog = {
    captureScope: () => () => mounted,
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
      t,
    })
    const action = install.actionFor(source)
    return (
      <>
        <button onClick={() => setDetailSourceKey(null)}>Close detail</button>
        {action && (
          <button disabled={install.busy} onClick={action}>
            Install
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
  const install = screen.getByRole('button', { name: 'Install' })
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

test('ignores stale native links and resolves the owned release by source key in the active catalog', async () => {
  const plugin = installedItem('local-owner', 'wework-personal', 'my-plugin')
  plugin.raw.spec.sourcePayload = { cloudPluginId: 17, cloudInstalledPluginId: 120 }
  const { api, publishPrivate } = renderAuthorDetail({
    plugin,
    listings: [
      { ...release, name: 'different-plugin', installedPluginId: 120 },
      { ...release, id: 18, accessRole: 'recipient' },
      { ...release, id: 19 },
    ],
  })
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() =>
    expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(19)
  )
  expect(publishPrivate).not.toHaveBeenCalled()
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
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
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

test('confirms and uploads the version in the exact packaged source', async () => {
  const installed = installedItem('local-owner', 'wework-personal', 'my-plugin')
  installed.version = '1.0.0'
  installed.raw.spec.version = '1.0.0'
  const archive = new JSZip()
  archive.file('.codex-plugin/plugin.json', JSON.stringify({ name: 'my-plugin', version: '1.1.0' }))
  const file = new File([await archive.generateAsync({ type: 'arraybuffer' })], 'my-plugin.zip')
  const packageCreatedPlugin = vi.fn().mockResolvedValue(file)
  const publishSubmission = vi.fn().mockRejectedValue(new Error('Upload fixture stopped'))
  const catalog = {
    captureScope: () => () => true,
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
    },
    accountIdentity,
    canInstallForAccount: true,
    personalDetailSourceKey: installed.raw.spec.source.pluginKey,
    localPluginApi: { packageCreatedPlugin },
    installedPlugins: [installed],
    pluginMarketplaceState: { items: [], isLoading: false, error: null },
    marketplaceCacheKeyValue: 'active-account',
  } as unknown as Omit<Parameters<typeof usePluginWorkspacePublishing>[0], 't'>

  function Author() {
    const { t } = useTranslation('common')
    const { personalInstallation } = usePluginWorkspacePublishing({ ...publishingInput, t })
    return (
      <>
        <button onClick={personalInstallation.actionFor(personalPluginInstallSource([installed]))}>
          Install
        </button>
        {personalInstallation.dialog}
      </>
    )
  }

  render(<Author />)
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
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

test('hides account install when a fresh catalog read reports an existing account installation', async () => {
  const { api } = renderAuthorDetail({ listings: [{ ...release, installedPluginId: 120 }] })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  )
  expect(api.installMarketplacePluginForAccount).not.toHaveBeenCalled()
})

test('a confirmed upload still installs for the account when the detail is closed', async () => {
  let finishUpload: (release: { pluginId: number; releaseId: number }) => void
  const upload = new Promise<{ pluginId: number; releaseId: number }>(resolve => {
    finishUpload = resolve
  })
  const { api, publishPrivate } = renderAuthorDetail({ publishPrivate: vi.fn(() => upload) })
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  fireEvent.click(await screen.findByTestId('personal-plugin-install-private-confirm'))
  await waitFor(() => expect(publishPrivate).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Close detail' }))
  await act(async () => finishUpload({ pluginId: 17, releaseId: 42 }))
  expect(api.installMarketplacePluginForAccount).toHaveBeenCalledExactlyOnceWith(17, 42)
})

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
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
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
