import { Boxes, CornerDownLeft, ExternalLink, Puzzle, Search } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LocalDeviceApp } from '@wegent/chat-core/runtime-composer-catalog'
import type { CollaborationTranslate } from '../i18n'
import { Tooltip } from '../issue-detail/Tooltip'
import { useCollaborationPortalTheme } from '../theme'
import { ComposerPluginIcon, type ComposerPluginIconProps } from './ComposerPluginIcon'
import { displayAppName } from './composerMentionCandidates'
import {
  useComposerCatalog,
  type ComposerCatalogEvents,
  type ComposerCatalogStore,
} from './useComposerCatalog'
import { useAnchoredPortalMenu } from './useAnchoredPortalMenu'
import { useOutsideClick } from './useOutsideClick'

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
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const isMenuOpen = useCallback(() => open, [open])
  const { apps, appsLoading, appsLoadError, loadLocalApps } = useComposerCatalog({
    onListLocalApps,
    appsStore,
    events: catalogEvents,
    isMenuOpen,
  })
  const availableApps = apps.filter(app => app.isEnabled !== false && app.isAccessible !== false)
  const enabledApps = sortApps ? sortApps(availableApps) : availableApps
  const portalTheme = useCollaborationPortalTheme()
  const layout = useAnchoredPortalMenu(open, rootRef, menuRef)
  useOutsideClick(rootRef, open, () => setOpen(false), [menuRef])
  const visibleApps = enabledApps.filter(app => {
    const text =
      `${app.id} ${app.name} ${app.description ?? ''} ${app.pluginDisplayNames?.join(' ') ?? ''}`.toLowerCase()
    return text.includes(query.trim().toLowerCase())
  })

  return (
    <div ref={rootRef} className="relative">
      <Tooltip
        label={t('workbench.composer_plugins', '插件')}
        align="start"
        testId="composer-plugin-picker-tooltip"
      >
        <button
          type="button"
          data-testid="composer-plugin-picker-button"
          disabled={disabled}
          aria-expanded={open}
          aria-label={t('workbench.composer_plugins', '插件')}
          className={[
            'flex items-center text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:opacity-40',
            iconOnly
              ? 'h-7 w-7 max-md:h-11 max-md:w-11 justify-center rounded-lg px-0'
              : 'h-8 max-md:h-11 gap-1.5 rounded-xl bg-muted px-2',
          ].join(' ')}
          onClick={() => {
            if (disabled) return
            if (!open) loadLocalApps({ force: true })
            setOpen(!open)
          }}
        >
          {iconOnly ? (
            <Puzzle className="h-4 w-4" />
          ) : (
            <>
              <span className="font-medium">{t('workbench.composer_plugins', '插件')}</span>
              <ComposerPluginPreviewIcons apps={enabledApps} resolveAppLogo={resolveAppLogo} />
              {enabledApps.length > 3 && (
                <span className="text-xs text-text-muted">+{enabledApps.length - 3}</span>
              )}
            </>
          )}
        </button>
      </Tooltip>

      {open &&
        createPortal(
          <div
            {...portalTheme}
            ref={menuRef}
            style={{
              ...portalTheme.style,
              top: layout?.top ?? 0,
              left: layout?.left ?? 0,
              maxHeight: layout?.maxHeight,
              visibility: layout ? undefined : 'hidden',
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setOpen(false)
                rootRef.current?.querySelector('button')?.focus()
              }
            }}
            data-testid="composer-plugin-picker"
            className={`${portalTheme.className} fixed z-system-popover flex flex-col w-[min(460px,calc(100vw-36px))] overflow-hidden rounded-xl border border-border/30 bg-popover p-2 text-text-primary shadow-xl`}
          >
            {appsLoadError && (
              <div
                role="alert"
                className="shrink-0 px-2 py-2 text-sm text-status-error"
                data-testid="composer-plugin-picker-error"
              >
                {t('workbench.composer_plugins_load_error')}
                <button
                  type="button"
                  disabled={disabled || appsLoading}
                  data-testid="composer-plugin-picker-retry"
                  className="ml-2 min-h-7 max-md:min-h-11 underline"
                  onClick={() => loadLocalApps({ force: true })}
                >
                  {t('workbench.retry')}
                </button>
              </div>
            )}
            <label className="relative mb-1 block shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                disabled={disabled}
                aria-label={t('workbench.composer_plugin_search')}
                data-testid="composer-plugin-picker-search"
                className="h-9 max-md:h-11 w-full rounded-lg border border-border/30 bg-background pl-9 pr-3 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
                placeholder={t('workbench.composer_plugin_search', '搜索插件')}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <div className="px-2 pb-1 pt-2 text-xs text-text-muted">
              {query
                ? t('workbench.composer_plugin_matches', '匹配结果')
                : t('workbench.composer_plugin_available', '可用插件')}
            </div>
            <div className="min-h-0 max-h-[280px] overflow-y-auto scrollbar-hide">
              {appsLoading && enabledApps.length === 0 ? (
                <div className="px-2 py-4 text-sm text-text-muted">
                  {t('workbench.plugins_loading_plugins', '正在加载插件')}
                </div>
              ) : visibleApps.length > 0 ? (
                visibleApps.slice(0, 8).map(app => {
                  return (
                    <button
                      key={app.id}
                      type="button"
                      disabled={disabled}
                      data-testid={`composer-plugin-picker-item-${app.id}`}
                      className="grid min-h-10 max-md:min-h-11 w-full grid-cols-[22px_auto_minmax(0,1fr)_16px] items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
                      title={app.description || undefined}
                      onClick={() => {
                        onSelect(app)
                        setOpen(false)
                      }}
                    >
                      <ComposerPluginIcon
                        name={app.name}
                        logo={resolveAppLogo(app)}
                        className="plugin-icon-slot h-[22px] w-[22px] rounded-md"
                        initialClassName="text-xs font-medium leading-none text-text-secondary"
                      />
                      <span className="min-w-0 truncate text-base leading-5">
                        {displayAppName(app)}
                      </span>
                      <span className="min-w-0 truncate text-base leading-5 text-text-muted">
                        {app.description}
                      </span>
                      <CornerDownLeft
                        className="h-3.5 w-3.5 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                    </button>
                  )
                })
              ) : appsLoadError ? null : (
                <div className="px-2 py-4 text-sm text-text-muted">
                  {t(
                    'workbench.composer_no_available_plugins',
                    '当前账号没有已安装且启用的匹配插件。'
                  )}
                </div>
              )}
            </div>
            {onOpenMarketplace ? (
              <button
                type="button"
                disabled={disabled}
                data-testid="composer-open-plugin-marketplace"
                className="mt-1 flex h-9 max-md:h-11 shrink-0 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
                onClick={() => {
                  setOpen(false)
                  onOpenMarketplace()
                }}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface">
                  <Boxes className="h-3.5 w-3.5 text-text-secondary" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {t('workbench.composer_open_plugin_marketplace', '打开插件市场')}
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              </button>
            ) : null}
          </div>,
          document.body
        )}
    </div>
  )
}
