import {
  composerAppNeedsAuthorization,
  isComposerAppSelectable,
} from '@wegent/chat-core/composer-plugin-metadata'
import type { LocalDeviceApp } from '@wegent/chat-core/runtime-composer-catalog'
import { Boxes, Puzzle } from 'lucide-react'
import { useCallback, useState } from 'react'
import { composerIconActionDensity } from '../controls/recipes'
import { SearchableSelect } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { ComposerPluginIcon, type ComposerPluginIconProps } from './ComposerPluginIcon'
import { displayAppName } from './composerMentionCandidates'
import {
  useComposerCatalog,
  type ComposerCatalogEvents,
  type ComposerCatalogStore,
} from './useComposerCatalog'

export interface PluginPickerMenuProps {
  translate: CollaborationTranslate
  disabled?: boolean
  iconOnly?: boolean
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  appsStore: ComposerCatalogStore<LocalDeviceApp>
  catalogEvents?: ComposerCatalogEvents
  sortApps?: (apps: LocalDeviceApp[]) => LocalDeviceApp[]
  resolveAppLogo: (app: LocalDeviceApp) => ComposerPluginIconProps['logo']
  onSelect: (app: LocalDeviceApp) => void
  onOpenMarketplace?: () => void
}
const EMPTY_EVENTS = {}

function ComposerPluginPreviewIcons({
  apps,
  resolveAppLogo,
}: {
  apps: LocalDeviceApp[]
  resolveAppLogo: PluginPickerMenuProps['resolveAppLogo']
}) {
  return (
    <span
      className="flex -space-x-1"
      data-testid="composer-plugin-preview-icons"
      aria-hidden="true"
    >
      {apps.slice(0, 3).map(app => (
        <ComposerPluginIcon
          key={app.id}
          name={app.name}
          logo={resolveAppLogo(app)}
          className="plugin-icon-slot h-6 w-6 rounded-full"
          testId={`composer-plugin-preview-icon-${app.id}`}
          initialClassName="text-xs font-medium leading-none text-text-secondary"
        />
      ))}
    </span>
  )
}

export function PluginPickerMenu({
  translate: t,
  disabled = false,
  iconOnly = false,
  onListLocalApps,
  appsStore,
  catalogEvents = EMPTY_EVENTS,
  sortApps,
  resolveAppLogo,
  onSelect,
  onOpenMarketplace,
}: PluginPickerMenuProps) {
  const [open, setOpen] = useState(false)
  const isMenuOpen = useCallback(() => open, [open])
  const { apps, appsLoading, appsLoadError, loadLocalApps } = useComposerCatalog({
    onListLocalApps,
    appsStore,
    events: catalogEvents,
    isMenuOpen,
  })
  const availableApps = apps.filter(isComposerAppSelectable)
  const enabledApps = sortApps ? sortApps(availableApps) : availableApps
  return (
    <SearchableSelect
      appearance="composer"
      value=""
      options={enabledApps.map(app => ({
        value: app.id,
        label: displayAppName(app),
        description: app.description ?? undefined,
        searchText: [app.id, app.name, ...(app.pluginDisplayNames ?? [])].join(' '),
        testId: `composer-plugin-picker-item-${app.id}`,
        icon: (
          <ComposerPluginIcon
            name={app.name}
            logo={resolveAppLogo(app)}
            className="plugin-icon-slot h-6 w-6 rounded-md"
            initialClassName="text-xs font-medium leading-none text-text-secondary"
          />
        ),
        badge: composerAppNeedsAuthorization(app) ? (
          <span
            className="text-xs text-text-secondary"
            data-testid={`composer-plugin-authorization-${app.id}`}
          >
            {t('workbench.composer_plugin_authorization_required', 'Authorization required')}
          </span>
        ) : undefined,
      }))}
      open={open}
      onOpenChange={next => {
        if (next) loadLocalApps({ force: true })
        setOpen(next)
      }}
      disabled={disabled}
      testId="composer-plugin-picker-button"
      menuTestId="composer-plugin-picker"
      searchTestId="composer-plugin-picker-search"
      accessibleLabel={t('workbench.composer_plugins', '插件')}
      searchPlaceholder={t('workbench.composer_plugin_search', '搜索插件')}
      emptyLabel={t(
        'workbench.composer_no_available_plugins',
        '当前账号没有已安装且启用的匹配插件。'
      )}
      className={iconOnly ? composerIconActionDensity + ' justify-center' : undefined}
      triggerContent={
        iconOnly ? (
          <Puzzle className="h-4 w-4" aria-hidden="true" />
        ) : (
          <>
            {enabledApps.length === 0 && <Puzzle className="h-4 w-4" aria-hidden="true" />}
            <span>{t('workbench.composer_plugins', '插件')}</span>
            <ComposerPluginPreviewIcons apps={enabledApps} resolveAppLogo={resolveAppLogo} />
            {enabledApps.length > 3 && (
              <span className="text-xs text-text-secondary">+{enabledApps.length - 3}</span>
            )}
          </>
        )
      }
      searchStatus={
        appsLoadError ? (
          <div
            role="alert"
            data-testid="composer-plugin-picker-error"
            className="p-2 text-sm text-destructive"
          >
            {t('workbench.composer_plugins_load_error')}
            <ControlButton
              variant="unstyled"
              disabled={disabled || appsLoading}
              data-testid="composer-plugin-picker-retry"
              onClick={() => loadLocalApps({ force: true })}
            >
              {t('workbench.retry')}
            </ControlButton>
          </div>
        ) : appsLoading && !enabledApps.length ? (
          <p role="status" className="p-3 text-sm text-text-secondary">
            {t('workbench.plugins_loading_plugins', '正在加载插件')}
          </p>
        ) : undefined
      }
      actions={
        onOpenMarketplace
          ? [
              {
                testId: 'composer-open-plugin-marketplace',
                label: t('workbench.composer_open_plugin_marketplace', '打开插件市场'),
                icon: <Boxes aria-hidden="true" className="h-4 w-4" />,
                onSelect: onOpenMarketplace,
              },
            ]
          : []
      }
      onChange={id => {
        const app = enabledApps.find(app => app.id === id)
        if (app) onSelect(app)
        setOpen(false)
      }}
    />
  )
}
