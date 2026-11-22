import type { LocalCodexPluginApi, LocalPluginImportCompletion } from '@/api/local/codexPlugins'
import { ApiError } from '@/api/http'
import {
  getKnownLocalExecutorDeviceId,
  getInitializedBundledPluginMarketplace,
} from '@/desktop/localExecutor'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import { normalizeMarketplaceSource } from '@wegent/chat-core/codex-installed-plugins'
import { readStoredCloudConnection } from '@/features/cloud-connection/cloudConnectionStorage'
import { beginOperation } from '@/telemetry/operationBus'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { linkedCloudPluginId } from '../installedPluginMerge'
import { toInstalledPluginItem } from '../installedPluginPresentation'
import { installedPluginMarketplaceId } from '../pluginDistribution'
import {
  createdPluginSlugFromKey,
  isPackableCreatedPlugin,
  personalPluginListingType,
} from '../pluginOwnerLocalPackage'
import { createDefaultPluginApi } from './marketplaceWorkspaceHelpers'

interface PersonalPluginCloudScope {
  apiBaseUrl?: string
  userId?: number | null
  getToken(): string | null | undefined
  onInstalled(): void
}

type LocalPluginSource = InstalledPlugin | LocalPluginImportCompletion
type AccountApi = ReturnType<typeof createDefaultPluginApi>

interface BackgroundInstall {
  cancelled: boolean
  isCurrent(): boolean
  commit?: Promise<void>
}

const pending = new Map<string, BackgroundInstall>()
const workKey = (device: string, pluginKey: string) =>
  JSON.stringify([device, createdPluginSlugFromKey(pluginKey)])

export function isLocalPersonalPlugin(plugin: InstalledPlugin): boolean {
  return (
    isPersonalMarketplaceId(installedPluginMarketplaceId(plugin) ?? '') &&
    isPackableCreatedPlugin(toInstalledPluginItem(plugin))
  )
}

export function ownedPersonalPluginSourceKey(item: PluginMarketplaceItem | null | undefined) {
  if (item?.visibility !== 'personal' || item.accessRole !== 'owner') return
  return item.localPersonalSource?.pluginName ?? item.name
}

/** Cancel pending work and let an already started write settle before removal preflight. */
export async function cancelPersonalPluginCloudInstall(pluginKey: string | undefined) {
  const device = getKnownLocalExecutorDeviceId()
  if (!pluginKey || !device) return
  const job = pending.get(workKey(device, pluginKey))
  if (!job) return
  job.cancelled = true
  await job.commit?.catch(() => undefined)
}

function sourceKey(source: LocalPluginSource): string | undefined {
  if ('spec' in source)
    return isLocalPersonalPlugin(source) ? source.spec.source.pluginKey : undefined
  if (getInitializedBundledPluginMarketplace()?.defaultPluginNames?.includes(source.pluginName))
    return undefined
  return source.pluginName
}

async function readRelease(api: AccountApi, slug: string) {
  const { items } = await api.listMarketplacePlugins()
  const matches = items.filter(
    item => item.visibility === 'personal' && item.accessRole === 'owner' && item.name === slug
  )
  if (matches.length > 1) throw new Error('Personal plugin cloud identity is ambiguous')
  return matches[0]
}

async function readPackageVersion(file: File): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(file)
  const manifestFile =
    archive.file('.codex-plugin/plugin.json') ?? archive.file('.claude-plugin/plugin.json')
  const manifest: unknown = manifestFile && JSON.parse(await manifestFile.async('string'))
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    !manifest.version.trim()
  ) {
    throw new Error('Personal plugin package version is unavailable')
  }
  return manifest.version.trim()
}

async function publishFirstRelease(
  api: AccountApi,
  local: LocalCodexPluginApi,
  plugin: InstalledPlugin,
  slug: string,
  requireCurrent: () => void
) {
  requireCurrent()
  const detailed = await local.readInstalledPluginDetail(plugin)
  requireCurrent()
  const file = await local.packageCreatedPlugin(plugin, requireCurrent)
  const version = await readPackageVersion(file)
  const completed = await api.publishSubmission(
    file,
    {
      slug,
      displayName: plugin.spec.displayName || plugin.spec.source.pluginKey,
      version,
      listingType: personalPluginListingType(detailed),
      purpose: 'restricted_share',
      visibility: 'personal',
      targets: [],
      allowCopy: false,
      privateFirstInstall: true,
    },
    requireCurrent
  )
  if (
    completed.submission.status !== 'approved' ||
    completed.plugin?.latestReleaseId !== completed.submission.releaseId
  ) {
    throw new Error('First private plugin release was not approved')
  }
  return completed.plugin
}

async function findImportedInstall(
  local: LocalCodexPluginApi,
  source: LocalPluginImportCompletion
) {
  const { items } = await local.listInstalledPlugins({ refresh: true, requireComplete: true })
  return items.find(plugin => {
    const path = plugin.spec.sourcePayload?.marketplacePath
    return (
      plugin.spec.source.pluginKey === source.pluginName &&
      plugin.spec.installState === 'installed' &&
      isLocalPersonalPlugin(plugin) &&
      typeof path === 'string' &&
      normalizeMarketplaceSource(path) === normalizeMarketplaceSource(source.marketplacePath)
    )
  })
}

async function syncPersonalInstall(
  api: AccountApi,
  local: LocalCodexPluginApi,
  source: LocalPluginSource,
  pluginKey: string,
  job: BackgroundInstall
) {
  const requireCurrent = () => {
    if (job.cancelled || !job.isCurrent()) {
      throw new DOMException('Personal plugin install scope changed', 'AbortError')
    }
  }
  requireCurrent()
  const slug = createdPluginSlugFromKey(pluginKey)
  const plugin = 'spec' in source ? source : await findImportedInstall(local, source)
  if (!plugin) return
  requireCurrent()
  let listing = await readRelease(api, slug)
  const linkedId = linkedCloudPluginId(plugin)
  if (linkedId !== null && linkedId !== Number(listing?.id))
    throw new Error('Personal plugin is linked to a different cloud source')
  let firstRelease = false
  if (!listing?.latestReleaseId) {
    try {
      listing = await publishFirstRelease(api, local, plugin, slug, requireCurrent)
      firstRelease = true
    } catch (error) {
      if (!(error instanceof ApiError) || error.errorCode !== 'PRIVATE_FIRST_INSTALL_CONFLICT')
        throw error
      requireCurrent()
      listing = await readRelease(api, slug)
      if (!listing?.latestReleaseId) throw error
    }
  }
  requireCurrent()
  const pluginId = Number(listing.id)
  const releaseId = listing.latestReleaseId
  if (!Number.isSafeInteger(pluginId) || pluginId <= 0 || !releaseId) {
    throw new Error('Personal plugin cloud release identity is unavailable')
  }
  job.commit = (async () => {
    await local.linkPersonalPluginRelease(plugin, pluginId, releaseId, {
      isCurrent: () => !job.cancelled && job.isCurrent(),
      accountInstall: firstRelease ? 'updateRelease' : 'keepRelease',
    })
    requireCurrent()
    if (listing.installedPluginId == null) {
      // The existing account install endpoint delivers to devices in the background.
      await api.installMarketplacePluginForAccount(pluginId, firstRelease ? releaseId : undefined)
    }
  })()
  await job.commit
  return true
}

/** Capture the initiating desktop account. The returned callback never waits on cloud work. */
export function capturePersonalPluginCloudInstall(
  local: LocalCodexPluginApi,
  { apiBaseUrl, userId, getToken, onInstalled }: PersonalPluginCloudScope
) {
  const session = readStoredCloudConnection()
  if (!session || session.apiBaseUrl !== apiBaseUrl || session.user.id !== userId) return undefined
  const initiatingDevice = getKnownLocalExecutorDeviceId()
  const accountIsCurrent = () => {
    const current = readStoredCloudConnection()
    return (
      current?.apiBaseUrl === session.apiBaseUrl &&
      current.user.id === session.user.id &&
      current.connectedAt === session.connectedAt
    )
  }

  const run = async (source: LocalPluginSource) => {
    const pluginKey = sourceKey(source)
    const device = getKnownLocalExecutorDeviceId()
    if (!pluginKey || !device || (initiatingDevice && device !== initiatingDevice)) return
    const isCurrent = () => accountIsCurrent() && getKnownLocalExecutorDeviceId() === device
    if (!isCurrent()) return
    const key = workKey(device, pluginKey)
    const previous = pending.get(key)
    if (previous && !previous.cancelled && previous.isCurrent()) return
    const job: BackgroundInstall = { cancelled: false, isCurrent }
    const attempt = beginOperation('plugin.install_request')
    pending.set(key, job)
    try {
      const token = getToken()
      if (!token || !isCurrent()) return attempt.cancel()
      const installed = await syncPersonalInstall(
        createDefaultPluginApi(apiBaseUrl, token),
        local,
        source,
        pluginKey,
        job
      )
      if (!installed || job.cancelled || !isCurrent()) return attempt.cancel()
      attempt.succeed()
      onInstalled()
    } catch (error) {
      if (job.cancelled || !isCurrent()) return attempt.cancel()
      attempt.fail('request')
      throw error
    } finally {
      if (pending.get(key) === job) pending.delete(key)
    }
  }

  return (source: LocalPluginSource) => {
    void run(source).catch(error => {
      console.warn('[Wework] Background personal plugin install failed', {
        error: error instanceof ApiError ? error.errorCode || error.status : 'local-or-transport',
      })
    })
  }
}

export type PersonalPluginCloudInstall = ReturnType<typeof capturePersonalPluginCloudInstall>
