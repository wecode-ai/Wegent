import { PluginPickerMenu as SharedPluginPickerMenu } from '@wegent/collaboration/composer/PluginPickerMenu'
import { useContext } from 'react'
import { PluginTrialSelectionContext } from '@wegent/collaboration/composer/PluginTrialSelectionContext'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import { prefetchLocalConnectorAuthForPluginNames } from '@/features/plugins/prefetchLocalConnectorAuth'
import { executeDshAction, type WeworkDshAction } from '@/features/dsh-runtime/dshActions'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalDeviceApp } from '@/types/api'
import { resolvePluginLogo } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import { appReference, displayAppName } from './composerMentionCandidates'
import { registerComposerMentionIcon } from './composerMentions'
import {
  RECENT_PLUGIN_APPS_KEY,
  readRecentPluginAppIds,
  sortComposerPluginsByUsage,
} from './composerPluginSort'
import { useComposerCatalogBinding } from './ComposerCatalogContext'

export function PluginPickerMenu(props: {
  disabled?: boolean
  iconOnly?: boolean
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  onInsertReference: (reference: string) => void
}) {
  const { t } = useTranslation('common')
  const showTrialGuide = useContext(PluginTrialSelectionContext)
  const catalog = useComposerCatalogBinding()
  const actions = useDshSlotEntries<WeworkDshAction>(WEWORK_DSH_SLOTS.action)
  const openPluginCenterAction = actions.find(action => action.id === 'plugin-center.open')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const resolveAppLogo = (app: LocalDeviceApp) =>
    resolvePluginLogo({
      pluginKey: composerAppPluginKey(app),
      logo: app.logoUrl,
      logoDark: app.logoUrlDark,
      appearanceMode,
    })
  return (
    <SharedPluginPickerMenu
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
      appsStore={catalog.appsStore}
      catalogEvents={catalog.catalogEvents}
      onListLocalApps={catalog.listApps ?? props.onListLocalApps}
      sortApps={sortComposerPluginsByUsage}
      resolveAppLogo={resolveAppLogo}
      onOpenMarketplace={
        openPluginCenterAction ? () => executeDshAction(openPluginCenterAction) : undefined
      }
      onSelect={app => {
        const reference = appReference(app)
        const logo = resolveAppLogo(app)
        if (logo.source === 'provided' && logo.url)
          registerComposerMentionIcon(reference, { url: logo.url, contrastPad: logo.contrastPad })
        props.onInsertReference(reference)
        showTrialGuide?.(displayAppName(app), app)
        if (catalog.prefetchLocalAuth)
          void prefetchLocalConnectorAuthForPluginNames([composerAppPluginKey(app)])
        const recent = [...readRecentPluginAppIds().keys()]
        window.localStorage.setItem(
          RECENT_PLUGIN_APPS_KEY,
          JSON.stringify([app.id, ...recent.filter(id => id !== app.id)].slice(0, 8))
        )
      }}
    />
  )
}
