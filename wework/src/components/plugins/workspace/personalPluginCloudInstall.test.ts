import JSZip from 'jszip'
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

vi.mock('./marketplaceWorkspaceHelpers', () => ({
  createDefaultPluginApi: () => ({
    listMarketplacePlugins: mocks.list,
    publishSubmission: mocks.publish,
    installMarketplacePluginForAccount: mocks.install,
  }),
}))

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
