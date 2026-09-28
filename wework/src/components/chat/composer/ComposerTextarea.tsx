import { forwardRef, useCallback, useMemo, useState } from 'react'
import { ComposerAutocompleteInput } from '@wegent/collaboration/composer/ComposerAutocompleteInput'
import type { ComposerHostBindingProps } from '@wegent/collaboration/composer/composerAutocompleteInputTypes'
import type { ComposerInputHandle } from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
import { useContext } from 'react'
import { PluginTrialSelectionContext } from '@wegent/collaboration/composer/PluginTrialSelectionContext'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import { executeDshAction, type WeworkDshAction } from '@/features/dsh-runtime/dshActions'
import { executeDshCommand } from '@/features/dsh-runtime/dshExtensions'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import { navigateTo } from '@/lib/navigation'
import { resolvePluginLogo } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import { canOpenNativeWorkspacePathPicker } from '@/lib/native-workspace-path-picker'
import type { LocalDeviceApp } from '@/types/api'
import { useComposerCatalogBinding } from './ComposerCatalogContext'
import {
  getDesktopComposerEditorServices,
  desktopComposerTransferServices,
  pickComposerWorkspacePaths,
} from './desktopComposerServices'
import { useDesktopComposerBindings } from './useDesktopComposerBindings'
import { useDesktopComposerContributions } from './useDesktopComposerContributions'
import { compareComposerPluginsByUsage } from './composerPluginSort'
import { ComposerPluginIcon } from './ComposerPluginIcon'
import { debugComposerEvent } from './composerDebug'
import { DesktopToolServices } from '../DesktopToolServices'
import type { ComposerTextareaProps } from './composerTextareaTypes'

export type { ComposerSubmitOptions } from './composerTextareaTypes'
export type { ComposerInputHandle as ComposerTextareaHandle } from '@wegent/collaboration/composer'
function DesktopComposerBindings(props: ComposerHostBindingProps) {
  useDesktopComposerBindings(props)
  return null
}
export const ComposerTextarea = forwardRef<ComposerInputHandle, ComposerTextareaProps>(
  function ComposerTextarea(props, ref) {
    const { t } = useTranslation('common')
    const showTrialGuide = useContext(PluginTrialSelectionContext)
    const catalog = useComposerCatalogBinding()
    const translate = useCallback(
      (key: string, fallback?: string, options?: Record<string, unknown>) =>
        String(t(key, { ...options, defaultValue: fallback })),
      [t]
    )
    const actions = useDshSlotEntries<WeworkDshAction>(WEWORK_DSH_SLOTS.action)
    const openPluginCenterAction = actions.find(action => action.id === 'plugin-center.open')
    const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
    const [mentionQuery, setMentionQuery] = useState('')
    const contributions = useDesktopComposerContributions(mentionQuery)
    const editorServices = useMemo(() => getDesktopComposerEditorServices(), [])
    const resolveAppLogo = useCallback(
      (app: LocalDeviceApp) =>
        resolvePluginLogo({
          pluginKey: composerAppPluginKey(app),
          logo: app.logoUrl,
          logoDark: app.logoUrlDark,
          appearanceMode,
        }),
      [appearanceMode]
    )
    return (
      <DesktopToolServices>
        <ComposerAutocompleteInput
          {...props}
          ref={ref}
          translate={translate}
          appsStore={catalog.appsStore}
          catalogEvents={catalog.catalogEvents}
          onListLocalApps={catalog.listApps ?? props.onListLocalApps}
          onListLocalSkills={catalog.listSkills ?? props.onListLocalSkills}
          editorServices={editorServices}
          transferServices={desktopComposerTransferServices}
          compareApps={compareComposerPluginsByUsage}
          resolveAppLogo={resolveAppLogo}
          onSelectApp={(title, app) => showTrialGuide?.(title, app)}
          onOpenMarketplace={
            openPluginCenterAction ? () => executeDshAction(openPluginCenterAction) : undefined
          }
          onOpenMentionPlugin={reference => navigateTo(buildPluginDetailRoute(reference))}
          renderAppIcon={command => (
            <ComposerPluginIcon
              app={command.app!}
              className="plugin-icon-slot h-6 w-6 rounded-md"
              initialClassName="text-xs font-medium leading-none text-text-secondary"
              testId={`slash-command-icon-${command.testId}`}
            />
          )}
          onPickWorkspacePaths={
            canOpenNativeWorkspacePathPicker() &&
            props.workspaceTarget?.workspaceSource !== 'remote'
              ? pickComposerWorkspacePaths
              : undefined
          }
          {...contributions}
          onMentionQueryChange={setMentionQuery}
          onExecuteCommand={(command, composer) =>
            executeDshCommand(command.command, undefined, {
              composer,
              menuId: command.menuId,
              menuLocation: 'composer.slash',
              source: 'slash',
            })
          }
          Bindings={DesktopComposerBindings}
          debug={debugComposerEvent}
        />
      </DesktopToolServices>
    )
  }
)
