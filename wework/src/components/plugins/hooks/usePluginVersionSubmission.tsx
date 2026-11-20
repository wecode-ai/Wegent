import { useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { PluginVersionSubmitDrawer } from '../PluginVersionSubmitDrawer'
import { hasNewPersonalPluginVersion } from '../pluginVersionSubmission'
import {
  createPluginVersionSubmissionState,
  type VersionSubmissionOptions,
} from './pluginVersionSubmissionState'

export function usePluginVersionSubmission(options: VersionSubmissionOptions) {
  const { t } = useTranslation('common')
  const source = useMemo(
    () => createPluginVersionSubmissionState(options.scopeKey),
    [options.scopeKey]
  )
  const { target, preparing, publishing, error, draft } = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot
  )
  const lastEligibilityDiagnostic = useRef('')

  return {
    actionFor(plugin: InstalledPluginItem | null, listing: PluginMarketplaceItem | null) {
      const eligible = hasNewPersonalPluginVersion(plugin, listing)
      if (import.meta.env.VITE_WEWORK_E2E === 'true') {
        const diagnostic = JSON.stringify({
          listingId: listing?.id,
          listingName: listing?.name,
          accessRole: listing?.accessRole,
          visibility: listing?.visibility,
          releaseId: listing?.latestReleaseId,
          catalogVersion: listing?.version,
          sharedVersion: listing?.sharedVersion,
          localId: plugin?.id,
          localVersion: plugin?.version,
          localOrigin: plugin?.origin,
          localSourceType: plugin?.raw.spec.source.type,
          localPluginKey: plugin?.raw.spec.source.pluginKey,
          managedByWegent: plugin?.raw.spec.sourcePayload?.managedByWegent,
          eligible,
        })
        if (diagnostic !== lastEligibilityDiagnostic.current) {
          lastEligibilityDiagnostic.current = diagnostic
          console.info('[plugin-version-eligibility]', diagnostic)
        }
      }
      if (!plugin || !listing || !eligible) return undefined
      return {
        currentVersion: (listing.sharedVersion ?? listing.version)!,
        nextVersion: plugin.version!,
        busy: preparing || publishing,
        onSubmit: () => void source.open(plugin, listing, options, t),
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
          onClose={source.dismiss}
          onSubmit={notes => void source.submit(notes, options, t)}
          onManageAccess={notes => {
            source.saveNotes(notes)
            source.dismiss()
            void options.onManageAccess(target.listing)
          }}
        />
      ) : null,
  }
}
