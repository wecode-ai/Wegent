import type { LocalCodexPluginApi, LocalPluginInstallSource } from '@/api/local/codexPlugins'
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
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginWorkspaceServices } from './pluginWorkspaceTypes'

interface PersonalPluginCloudScope {
  apiBaseUrl?: string
  userId?: number | null
  getToken(): string | null | undefined
  onInstalled(): void
}

type LocalPluginSource = InstalledPlugin | LocalPluginInstallSource
type AccountApi = ReturnType<typeof createDefaultPluginApi>

interface BackgroundInstall {
  cancelled: boolean
  isCurrent(): boolean
  settled?: Promise<void>
  completed?: boolean
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

/** Stop later writes and settle publication and installation before removal preflight. */
export async function cancelPersonalPluginCloudInstall(pluginKey: string | undefined) {
  const device = getKnownLocalExecutorDeviceId()
  if (!pluginKey || !device) return
  const job = pending.get(workKey(device, pluginKey))
  if (!job) return
  job.cancelled = true
  await job.settled?.catch(() => undefined)
}

function sourceKey(source: LocalPluginSource): string | undefined {
  if ('spec' in source)
    return isLocalPersonalPlugin(source) ? source.spec.source.pluginKey : undefined
  if (getInitializedBundledPluginMarketplace()?.defaultPluginNames?.includes(source.pluginName))
    return undefined
  return source.pluginName
}

export async function readOwnedPersonalPluginRelease(
  api: Pick<AccountApi, 'listMarketplacePlugins'>,
  slug: string
) {
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
      restoreDeleted: true,
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

async function findImportedInstall(local: LocalCodexPluginApi, source: LocalPluginInstallSource) {
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

type PersonalReleasePlan =
  | { restoreDeleted: true; pluginId: number }
  | {
      restoreDeleted: false
      pluginId: number
      releaseId: number
      firstRelease: boolean
      installed: boolean
    }

async function personalReleasePlan(
  api: AccountApi,
  local: LocalCodexPluginApi,
  plugin: InstalledPlugin,
  slug: string,
  requireCurrent: () => void
): Promise<PersonalReleasePlan> {
  let listing = await readOwnedPersonalPluginRelease(api, slug)
  requireCurrent()
  const linkedId = linkedCloudPluginId(plugin)
  if (linkedId !== null && listing && linkedId !== Number(listing.id))
    throw new Error('Personal plugin is linked to a different cloud source')
  if (!listing && linkedId !== null) return { restoreDeleted: true, pluginId: linkedId }
  let firstRelease = false
  if (!listing?.latestReleaseId) {
    try {
      listing = await publishFirstRelease(api, local, plugin, slug, requireCurrent)
      firstRelease = true
    } catch (error) {
      requireCurrent()
      if (error instanceof ApiError && error.errorCode === 'PRIVATE_PLUGIN_REINSTALL_REQUIRED') {
        const detail = error.detail as { pluginId?: unknown } | undefined
        const pluginId = Number(detail?.pluginId)
        if (Number.isSafeInteger(pluginId) && pluginId > 0)
          return { restoreDeleted: true, pluginId }
      }
      if (!(error instanceof ApiError) || error.errorCode !== 'PRIVATE_FIRST_INSTALL_CONFLICT')
        throw error
      listing = await readOwnedPersonalPluginRelease(api, slug)
      if (!listing?.latestReleaseId) throw error
    }
  }
  const pluginId = Number(listing.id)
  const releaseId = listing.latestReleaseId
  if (!Number.isSafeInteger(pluginId) || pluginId <= 0 || !releaseId)
    throw new Error('Personal plugin cloud release identity is unavailable')
  return {
    restoreDeleted: false,
    pluginId,
    releaseId,
    firstRelease,
    installed: listing.installedPluginId != null,
  }
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
  if (!plugin) {
    requireCurrent()
    throw new Error('Installed personal plugin source is unavailable')
  }
  requireCurrent()
  const plan = await personalReleasePlan(api, local, plugin, slug, requireCurrent)
  requireCurrent()
  if (plan.restoreDeleted) {
    const response = await api.installMarketplacePluginForAccount(plan.pluginId, undefined, true)
    const restored = response.plugin
    requireCurrent()
    if (restored.spec.pluginId !== plan.pluginId || !restored.spec.releaseId)
      throw new Error('Restored private plugin identity was not confirmed')
    await local.linkPersonalPluginRelease(plugin, plan.pluginId, restored.spec.releaseId, {
      isCurrent: () => !job.cancelled && job.isCurrent(),
      accountInstall: 'updateRelease',
    })
    return
  }
  await local.linkPersonalPluginRelease(plugin, plan.pluginId, plan.releaseId, {
    isCurrent: () => !job.cancelled && job.isCurrent(),
    accountInstall: plan.firstRelease ? 'updateRelease' : 'keepRelease',
  })
  requireCurrent()
  if (!plan.installed) {
    // The existing account install endpoint delivers to devices in the background.
    await api.installMarketplacePluginForAccount(
      plan.pluginId,
      plan.firstRelease ? plan.releaseId : undefined
    )
  }
}

/** Keep account and executor ownership independent of the plugin page's lifetime. */
export function capturePersonalPluginInstallScope() {
  const session = readStoredCloudConnection()
  const device = getKnownLocalExecutorDeviceId()
  return () => {
    const current = readStoredCloudConnection()
    return (
      current?.apiBaseUrl === session?.apiBaseUrl &&
      current?.user.id === session?.user.id &&
      current?.connectedAt === session?.connectedAt &&
      (!device || getKnownLocalExecutorDeviceId() === device)
    )
  }
}

/** Capture the initiating desktop account; callers can await completion when needed. */
export function capturePersonalPluginCloudInstall(
  local: LocalCodexPluginApi,
  { apiBaseUrl, userId, getToken, onInstalled }: PersonalPluginCloudScope
) {
  const session = readStoredCloudConnection()
  if (!session || session.apiBaseUrl !== apiBaseUrl || session.user.id !== userId) return undefined
  const scopeIsCurrent = capturePersonalPluginInstallScope()

  const run = async (source: LocalPluginSource) => {
    const pluginKey = sourceKey(source)
    const device = getKnownLocalExecutorDeviceId()
    if (!pluginKey || !device) return false
    const isCurrent = () => scopeIsCurrent() && getKnownLocalExecutorDeviceId() === device
    if (!isCurrent()) return false
    const key = workKey(device, pluginKey)
    const previous = pending.get(key)
    if (previous && !previous.cancelled && previous.isCurrent()) {
      await previous.settled
      return previous.completed === true && !previous.cancelled && isCurrent()
    }
    const job: BackgroundInstall = { cancelled: false, isCurrent }
    const attempt = beginOperation('plugin.install_request')
    pending.set(key, job)
    try {
      const token = getToken()
      if (!token || !isCurrent()) {
        attempt.cancel()
        return false
      }
      job.settled = syncPersonalInstall(
        createDefaultPluginApi(apiBaseUrl, token),
        local,
        source,
        pluginKey,
        job
      )
      await job.settled
      if (job.cancelled || !isCurrent()) {
        attempt.cancel()
        return false
      }
      attempt.succeed()
      onInstalled()
      job.completed = true
      return true
    } catch (error) {
      if (job.cancelled || !isCurrent()) {
        attempt.cancel()
        return false
      }
      attempt.fail('request')
      throw error
    } finally {
      if (pending.get(key) === job) pending.delete(key)
    }
  }

  return (source: LocalPluginSource) => {
    return run(source).catch(error => {
      console.warn('[Wework] Background personal plugin install failed', {
        error: error instanceof ApiError ? error.errorCode || error.status : 'local-or-transport',
      })
      return false
    })
  }
}

export type PersonalPluginCloudInstall = ReturnType<typeof capturePersonalPluginCloudInstall>

/** Rebind the owned source, then let the existing full refresh verify its device state. */
export async function syncPersonalPluginToCurrentAccount({
  plugin,
  listing,
  sync,
  catalog,
  operations,
  t,
}: Pick<PluginWorkspaceServices, 'catalog' | 'operations' | 't'> & {
  plugin: InstalledPluginItem
  listing: PluginMarketplaceItem
  sync: NonNullable<PersonalPluginCloudInstall>
}) {
  const isCurrent = catalog.captureScope()
  if (
    !isCurrent() ||
    !isLocalPersonalPlugin(plugin.raw) ||
    listing.accessRole !== 'owner' ||
    listing.visibility !== 'personal' ||
    operations.getSnapshot().installingMarketplacePluginIds.has(listing.id)
  )
    return
  operations.beginInstall(listing.id)
  catalog.showNotice({
    id: `personal-account-sync-${listing.id}`,
    kind: 'authorization',
    message: t('workbench.plugins_sync_to_account_pending', '正在同步到当前账号…'),
  })
  let completed: boolean
  try {
    completed = await sync(plugin.raw)
  } finally {
    operations.finishInstall(listing.id)
  }
  if (!isCurrent()) return
  if (completed) {
    catalog.refresh(true)
  } else {
    catalog.showNotice({
      id: `personal-account-sync-error-${listing.id}`,
      kind: 'error',
      message: t(
        'workbench.plugins_sync_to_account_failed',
        '同步到当前账号失败，请检查连接后重试'
      ),
    })
  }
}
