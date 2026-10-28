import { useLayoutEffect, useRef, useState } from 'react'
import type { createPluginApi } from '@/api/plugins'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { beginOperation } from '@/telemetry/operationBus'
import type {
  PluginAccessResponse,
  PluginMarketplaceItem,
  PluginSubmissionCompleteResponse,
} from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginOperationNoticeState } from '../PluginOperationNotice'
import { PluginVersionSubmitDrawer } from '../PluginVersionSubmitDrawer'
import { hasNewPersonalPluginVersion } from '../pluginVersionSubmission'

interface SubmissionTarget {
  scopeKey: string
  lifetime: symbol
  plugin: InstalledPluginItem
  listing: PluginMarketplaceItem
  access: PluginAccessResponse
}

interface VersionSubmissionOptions {
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

export function usePluginVersionSubmission(options: VersionSubmissionOptions) {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState<SubmissionTarget | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState({ pluginId: '', notes: '' })
  const [scopeKey, setScopeKey] = useState(options.scopeKey)
  const submitting = useRef(false)
  const lifetime = useRef<symbol | null>(null)

  if (scopeKey !== options.scopeKey) {
    setScopeKey(options.scopeKey)
    setTarget(null)
    setError(null)
    setPreparing(false)
    setPublishing(false)
    setDraft({ pluginId: '', notes: '' })
  }

  useLayoutEffect(() => {
    const current = Symbol('plugin-version-submission')
    lifetime.current = current
    submitting.current = false
    return () => {
      if (lifetime.current === current) lifetime.current = null
    }
  }, [options.scopeKey])

  const open = async (plugin: InstalledPluginItem, listing: PluginMarketplaceItem) => {
    const currentLifetime = lifetime.current
    if (
      !currentLifetime ||
      preparing ||
      submitting.current ||
      !hasNewPersonalPluginVersion(plugin, listing)
    )
      return
    setPreparing(true)
    setError(null)
    const scopeKey = options.scopeKey
    try {
      const access = await options.pluginApi.getMarketplacePluginAccess(listing.id)
      if (lifetime.current !== currentLifetime) return
      setDraft(current =>
        current.pluginId === String(listing.id)
          ? current
          : { pluginId: String(listing.id), notes: '' }
      )
      setTarget({ scopeKey, lifetime: currentLifetime, plugin, listing, access })
    } catch (failure) {
      if (lifetime.current !== currentLifetime) return
      options.onNotice({
        id: `plugin-version-load-failed-${listing.id}`,
        kind: 'error',
        message: getErrorMessage(failure, t('workbench.plugins_publication_readiness_failed')),
      })
    } finally {
      if (lifetime.current === currentLifetime) setPreparing(false)
    }
  }

  const submit = async (notes: string) => {
    if (
      !target ||
      target.scopeKey !== options.scopeKey ||
      target.lifetime !== lifetime.current ||
      submitting.current ||
      !notes.trim() ||
      notes.trim().length > 2000
    )
      return
    submitting.current = true
    setPublishing(true)
    setError(null)
    setDraft(current => ({ ...current, notes }))
    const attempt = beginOperation('plugin.publish')
    const currentLifetime = target.lifetime
    try {
      const file = await options.localPluginApi.packageCreatedPlugin(target.plugin.raw)
      if (lifetime.current !== currentLifetime) {
        attempt.cancel()
        return
      }
      const completed = await options.pluginApi.publishSubmission(file, {
        slug: target.listing.name,
        displayName: target.plugin.name,
        version: target.plugin.version!,
        listingType: target.listing.listingType ?? 'plugin',
        purpose: 'restricted_share',
        visibility: 'personal',
        releaseNotes: notes.trim(),
      })
      if (lifetime.current !== currentLifetime) {
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
      await options.onPublished(
        target.plugin,
        completed,
        () => lifetime.current === currentLifetime
      )
      if (lifetime.current !== currentLifetime) {
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
      if (lifetime.current !== currentLifetime) {
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
      if (lifetime.current === currentLifetime) {
        submitting.current = false
        setPublishing(false)
      }
    }
  }

  return {
    actionFor(plugin: InstalledPluginItem | null, listing: PluginMarketplaceItem | null) {
      if (!plugin || !listing || !hasNewPersonalPluginVersion(plugin, listing)) return undefined
      return {
        currentVersion: (listing.sharedVersion ?? listing.version)!,
        nextVersion: plugin.version!,
        busy: preparing || publishing,
        onSubmit: () => void open(plugin, listing),
      }
    },
    drawer:
      target && target.scopeKey === options.scopeKey ? (
        <PluginVersionSubmitDrawer
          pluginName={target.plugin.name}
          currentVersion={(target.listing.sharedVersion ?? target.listing.version)!}
          nextVersion={target.plugin.version!}
          access={target.access}
          initialReleaseNotes={draft.notes}
          publishing={publishing}
          error={error}
          onClose={() => setTarget(null)}
          onSubmit={notes => void submit(notes)}
          onManageAccess={notes => {
            setDraft(current => ({ ...current, notes }))
            setTarget(null)
            void options.onManageAccess(target.listing)
          }}
        />
      ) : null,
  }
}
