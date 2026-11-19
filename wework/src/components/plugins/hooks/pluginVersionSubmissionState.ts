import type { createPluginApi } from '@/api/plugins'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { TFunction } from 'i18next'
import { getErrorMessage } from '@/lib/error-message'
import { beginOperation } from '@/telemetry/operationBus'
import type {
  PluginAccessResponse,
  PluginMarketplaceItem,
  PluginSubmissionCompleteResponse,
} from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginOperationNoticeState } from '../PluginOperationNotice'
import { createdPluginSlugFromKey } from '../pluginOwnerLocalPackage'
import { hasNewPersonalPluginVersion } from '../pluginVersionSubmission'

interface SubmissionTarget {
  scopeKey: string
  lifetime: symbol
  plugin: InstalledPluginItem
  listing: PluginMarketplaceItem
  access: PluginAccessResponse
}

export interface VersionSubmissionOptions {
  scopeKey: string
  pluginApi: Pick<
    ReturnType<typeof createPluginApi>,
    'getMarketplacePluginAccess' | 'publishSubmission'
  >
  localPluginApi: Pick<LocalCodexPluginApi, 'packageCreatedPlugin'>
  onPublished: (
    plugin: InstalledPluginItem,
    completed: PluginSubmissionCompleteResponse,
    isCurrent: () => boolean
  ) => Promise<unknown>
  onNotice: (notice: PluginOperationNoticeState) => void
  onManageAccess: (listing: PluginMarketplaceItem) => Promise<void>
}

interface SubmissionState {
  target: SubmissionTarget | null
  preparing: boolean
  publishing: boolean
  error: string | null
  draft: { pluginId: string; notes: string }
}

/** A workspace scope owns the drawer and each admission, package and publication request. */
export function createPluginVersionSubmissionState(sourceScopeKey: string) {
  const listeners = new Set<() => void>()
  let lifetime: symbol | null = null
  let submitting = false
  let snapshot: SubmissionState = {
    target: null,
    preparing: false,
    publishing: false,
    error: null,
    draft: { pluginId: '', notes: '' },
  }
  const publish = (patch: Partial<SubmissionState>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const setTarget = (target: SubmissionTarget | null) => publish({ target })
  const setPreparing = (preparing: boolean) => publish({ preparing })
  const setPublishing = (publishing: boolean) => publish({ publishing })
  const setError = (error: string | null) => publish({ error })
  const setDraft = (change: (draft: SubmissionState['draft']) => SubmissionState['draft']) =>
    publish({ draft: change(snapshot.draft) })

  const open = async (
    plugin: InstalledPluginItem,
    listing: PluginMarketplaceItem,
    options: VersionSubmissionOptions,
    t: TFunction<'common'>
  ) => {
    const currentLifetime = lifetime
    if (
      !currentLifetime ||
      snapshot.preparing ||
      submitting ||
      !hasNewPersonalPluginVersion(plugin, listing)
    )
      return
    setPreparing(true)
    setError(null)
    const scopeKey = sourceScopeKey
    try {
      const access = await options.pluginApi.getMarketplacePluginAccess(listing.id)
      if (lifetime !== currentLifetime) return
      setDraft(current =>
        current.pluginId === String(listing.id)
          ? current
          : { pluginId: String(listing.id), notes: '' }
      )
      setTarget({ scopeKey, lifetime: currentLifetime, plugin, listing, access })
    } catch (failure) {
      if (lifetime !== currentLifetime) return
      options.onNotice({
        id: `plugin-version-load-failed-${listing.id}`,
        kind: 'error',
        message: getErrorMessage(failure, t('workbench.plugins_publication_readiness_failed')),
      })
    } finally {
      if (lifetime === currentLifetime) setPreparing(false)
    }
  }

  const submit = async (
    notes: string,
    options: VersionSubmissionOptions,
    t: TFunction<'common'>
  ) => {
    const target = snapshot.target
    if (
      !target ||
      target.scopeKey !== options.scopeKey ||
      target.lifetime !== lifetime ||
      submitting ||
      !notes.trim() ||
      notes.trim().length > 2000
    )
      return
    submitting = true
    setPublishing(true)
    setError(null)
    setDraft(current => ({ ...current, notes }))
    const attempt = beginOperation('plugin.publish')
    const currentLifetime = target.lifetime
    try {
      const file = await options.localPluginApi.packageCreatedPlugin(target.plugin.raw)
      if (lifetime !== currentLifetime) {
        attempt.cancel()
        return
      }
      const completed = await options.pluginApi.publishSubmission(file, {
        slug: createdPluginSlugFromKey(target.plugin.raw.spec.source.pluginKey),
        displayName: target.plugin.name,
        version: target.plugin.version!,
        listingType: target.listing.listingType ?? 'plugin',
        purpose: 'restricted_share',
        visibility: 'personal',
        releaseNotes: notes.trim(),
      })
      if (lifetime !== currentLifetime) {
        attempt.cancel()
        return
      }
      if (completed.submission.status !== 'approved' || !completed.plugin?.latestReleaseId) {
        throw new Error(
          completed.submission.reviewNote || t('workbench.plugins_version_submit_failed')
        )
      }
      if (completed.plugin.latestReleaseId !== completed.submission.releaseId) {
        throw new Error(t('workbench.plugins_version_submit_superseded'))
      }
      await options.onPublished(target.plugin, completed, () => lifetime === currentLifetime)
      if (lifetime !== currentLifetime) {
        attempt.cancel()
        return
      }
      attempt.succeed()
      setTarget(null)
      setDraft(current => ({ ...current, notes: '' }))
      options.onNotice({
        id: `plugin-version-submitted-${completed.submission.id}`,
        kind: 'success',
        message: t('workbench.plugins_version_submit_success', { version: target.plugin.version }),
      })
    } catch (failure) {
      if (lifetime !== currentLifetime) {
        attempt.cancel()
        return
      }
      attempt.fail('request')
      const message = getErrorMessage(failure, t('workbench.plugins_version_submit_failed'))
      setError(
        /version already exists/i.test(message)
          ? t('workbench.plugins_version_exists_hint')
          : message
      )
    } finally {
      if (lifetime === currentLifetime) {
        submitting = false
        setPublishing(false)
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        lifetime = Symbol('plugin-version-submission')
        submitting = false
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) lifetime = null
      }
    },
    open,
    submit,
    dismiss: () => setTarget(null),
    saveNotes: (notes: string) => setDraft(current => ({ ...current, notes })),
  }
}
