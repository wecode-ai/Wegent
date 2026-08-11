import { Boxes, CornerDownLeft, ExternalLink, Puzzle, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  LOCAL_PLUGIN_SKILLS_CHANGED_EVENT,
  insertPluginReference,
  showPluginTrialGuide,
} from '@/features/plugins/pluginTrial'
import { composerAppPluginKey } from '@/features/plugins/composerPluginMetadata'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip } from '@/components/ui/tooltip'
import { navigateTo } from '@/lib/navigation'
import type { LocalDeviceApp } from '@/types/api'
import { resolvePluginLogoUrl } from '@/components/plugins/plugin-assets'
import { useOptionalAppearance } from '@/features/appearance'
import {
  getComposerApps,
  publishComposerApps,
  requestComposerAppsSync,
  subscribeComposerApps,
} from './composerAppsSnapshot'
import { appReference, displayAppName } from './composerMentionCandidates'
import { registerComposerMentionIcon } from './composerMentions'
import {
  RECENT_PLUGIN_APPS_KEY,
  readRecentPluginAppIds,
  sortComposerPluginsByUsage,
} from './composerPluginSort'

interface PluginPickerMenuProps {
  disabled?: boolean
  iconOnly?: boolean
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
}

function enabledComposerApps(items: LocalDeviceApp[]): LocalDeviceApp[] {
  return sortComposerPluginsByUsage(
    items.filter(app => app.isEnabled !== false && app.isAccessible !== false),
    readRecentPluginAppIds()
  )
}

function paintComposerApps(items: LocalDeviceApp[]): LocalDeviceApp[] {
  return enabledComposerApps(items.length > 0 ? items : getComposerApps())
}

function ComposerPluginPreviewIcons({
  apps,
  appearanceMode,
}: {
  apps: LocalDeviceApp[]
  appearanceMode: 'light' | 'dark'
}) {
  return (
    <span
      className="flex -space-x-1"
      data-testid="composer-plugin-preview-icons"
      aria-hidden="true"
    >
      {apps.slice(0, 3).map(app => {
        const logo = resolvePluginLogoUrl({
          pluginKey: composerAppPluginKey(app),
          logo: app.logoUrl,
          logoDark: app.logoUrlDark,
          appearanceMode,
        })
        return (
          <span
            key={app.id}
            data-testid={`composer-plugin-preview-icon-${app.id}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/30 bg-background"
          >
            {logo ? (
              <img src={logo} alt="" className="h-full w-full object-contain" />
            ) : (
              <Boxes className="h-4 w-4" />
            )}
          </span>
        )
      })}
    </span>
  )
}

export function PluginPickerMenu({
  disabled = false,
  iconOnly = false,
  onListLocalApps,
}: PluginPickerMenuProps) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [apps, setApps] = useState<LocalDeviceApp[]>(() => paintComposerApps(getComposerApps()))
  const hasCachedAppsRef = useRef(apps.length > 0)
  const [loading, setLoading] = useState(() => Boolean(onListLocalApps) && apps.length === 0)
  const [reloadToken, setReloadToken] = useState(0)

  const applySharedApps = (
    items: LocalDeviceApp[] = getComposerApps(),
    options?: { allowEmpty?: boolean }
  ) => {
    const next = options?.allowEmpty && items.length === 0 ? [] : paintComposerApps(items)
    if (next.length === 0) {
      if (options?.allowEmpty) {
        hasCachedAppsRef.current = false
        setApps([])
        setLoading(false)
      }
      return false
    }
    hasCachedAppsRef.current = true
    setApps(next)
    setLoading(false)
    return true
  }

  useEffect(() => {
    return subscribeComposerApps(() => {
      applySharedApps(getComposerApps(), { allowEmpty: true })
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    const onSkillsChanged = () => {
      // Keep showing the last known plugins while refresh runs; an empty refresh
      // still falls back to the shared store in load(). Avoid flipping into the
      // loading placeholder when we already have a usable list.
      if (!hasCachedAppsRef.current) setLoading(Boolean(onListLocalApps))
      setReloadToken(token => token + 1)
    }
    window.addEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, onSkillsChanged)
    return () => window.removeEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, onSkillsChanged)
  }, [onListLocalApps])

  useEffect(() => {
    let current = true
    let retryTimer: number | null = null
    if (!onListLocalApps) return
    if (!hasCachedAppsRef.current) setLoading(true)

    const applySharedOrRetry = (attempt: number) => {
      requestComposerAppsSync()
      if (applySharedApps()) return true
      hasCachedAppsRef.current = false
      setApps([])
      // Install → notify can race ahead of plugin/installed. Retry whether the
      // menu is open or closed so the toolbar does not stay empty after a
      // transient cloud/list failure on first paint.
      if (attempt < 30) {
        retryTimer = window.setTimeout(() => load(attempt + 1), attempt < 6 ? 500 : 1000)
      }
      return false
    }

    const load = (attempt: number) => {
      // Pull slash's live React list into the window store before fetching, so a
      // stale/empty network result cannot blank a picker that `/` already filled.
      requestComposerAppsSync()
      onListLocalApps()
        .then(items => {
          if (!current) return
          const next = enabledComposerApps(items)
          if (next.length > 0) {
            publishComposerApps(items)
            hasCachedAppsRef.current = true
            setApps(next)
            return
          }
          applySharedOrRetry(attempt)
        })
        .catch(() => {
          if (!current) return
          applySharedOrRetry(attempt)
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    }

    load(0)
    return () => {
      current = false
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [onListLocalApps, open, reloadToken])

  const visibleApps = apps.filter(app => {
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
              ? 'h-7 w-7 justify-center rounded-lg px-0'
              : 'h-8 gap-1.5 rounded-xl bg-muted px-2',
          ].join(' ')}
          onClick={() => {
            if (disabled) return
            if (!open) {
              // Ask slash to re-publish first — `/` may already have apps in React
              // state while this menu's store was emptied by HMR or a failed refresh.
              requestComposerAppsSync()
              if (!applySharedApps()) {
                if (onListLocalApps) {
                  setLoading(true)
                  setReloadToken(token => token + 1)
                }
              }
            }
            setOpen(!open)
          }}
        >
          {iconOnly ? (
            <Puzzle className="h-4 w-4" />
          ) : (
            <>
              <span className="font-medium">{t('workbench.composer_plugins', '插件')}</span>
              <ComposerPluginPreviewIcons apps={apps} appearanceMode={appearanceMode} />
              {apps.length > 3 && (
                <span className="text-xs text-text-muted">+{apps.length - 3}</span>
              )}
            </>
          )}
        </button>
      </Tooltip>

      {open && (
        <div
          data-testid="composer-plugin-picker"
          className="absolute bottom-9 left-0 z-popover w-[min(460px,calc(100vw-36px))] overflow-hidden rounded-xl border border-border/30 bg-popover p-2 shadow-xl"
        >
          <label className="relative mb-1 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              data-testid="composer-plugin-picker-search"
              className="h-9 w-full rounded-lg border border-border/30 bg-background pl-9 pr-3 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
              placeholder={t('workbench.composer_plugin_search', '搜索插件')}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <div className="px-2 pb-1 pt-2 text-xs text-text-muted">
            {query
              ? t('workbench.composer_plugin_matches', '匹配结果')
              : t('workbench.composer_plugin_available', '可用插件')}
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {loading ? (
              <div className="px-2 py-4 text-sm text-text-muted">
                {t('workbench.plugins_loading_plugins', '正在加载插件')}
              </div>
            ) : visibleApps.length > 0 ? (
              visibleApps.slice(0, 8).map(app => {
                const logo = resolvePluginLogoUrl({
                  pluginKey: composerAppPluginKey(app),
                  logo: app.logoUrl,
                  logoDark: app.logoUrlDark,
                  appearanceMode,
                })
                return (
                  <button
                    key={app.id}
                    type="button"
                    data-testid={`composer-plugin-picker-item-${app.id}`}
                    className="grid min-h-10 w-full grid-cols-[22px_auto_minmax(0,1fr)_16px] items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
                    title={app.description || undefined}
                    onClick={() => {
                      const reference = appReference(app)
                      registerComposerMentionIcon(reference, logo)
                      insertPluginReference(reference)
                      showPluginTrialGuide(displayAppName(app), app.trialTemplates)
                      const recent = JSON.parse(
                        window.localStorage.getItem(RECENT_PLUGIN_APPS_KEY) || '[]'
                      ) as string[]
                      window.localStorage.setItem(
                        RECENT_PLUGIN_APPS_KEY,
                        JSON.stringify([app.id, ...recent.filter(id => id !== app.id)].slice(0, 8))
                      )
                      setOpen(false)
                    }}
                  >
                    <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/30 bg-background">
                      {logo ? (
                        <img src={logo} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Boxes className="h-3.5 w-3.5 text-text-muted" />
                      )}
                    </span>
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
            ) : (
              <div className="px-2 py-4 text-sm text-text-muted">
                {t(
                  'workbench.composer_no_available_plugins',
                  '当前账号没有已安装且启用的匹配插件。'
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            data-testid="composer-open-plugin-marketplace"
            className="mt-1 flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
            onClick={() => {
              setOpen(false)
              navigateTo('/plugins')
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
        </div>
      )}
    </div>
  )
}
