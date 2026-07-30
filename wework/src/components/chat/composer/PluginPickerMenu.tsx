import { Boxes, CornerDownLeft, ExternalLink, Puzzle, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { insertPluginReference } from '@/features/plugins/pluginTrial'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { LocalDeviceApp } from '@/types/api'
import { resolvePluginAssetUrl } from '@/components/plugins/plugin-assets'
import { appReference, displayAppName } from './composerMentionCandidates'
import { OPEN_COMPOSER_PLUGIN_PICKER_EVENT } from './composerEvents'
import { registerComposerMentionIcon } from './composerMentions'

interface PluginPickerMenuProps {
  disabled?: boolean
  iconOnly?: boolean
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
}

const RECENT_PLUGIN_APPS_KEY = 'wework:composer:recent-plugin-apps'

export function PluginPickerMenu({
  disabled = false,
  iconOnly = false,
  onListLocalApps,
}: PluginPickerMenuProps) {
  const { t } = useTranslation('common')
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [apps, setApps] = useState<LocalDeviceApp[]>([])
  const [loading, setLoading] = useState(Boolean(onListLocalApps))

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    const onOpenPicker = () => {
      if (disabled) return
      setOpen(true)
    }
    window.addEventListener(OPEN_COMPOSER_PLUGIN_PICKER_EVENT, onOpenPicker)
    return () => window.removeEventListener(OPEN_COMPOSER_PLUGIN_PICKER_EVENT, onOpenPicker)
  }, [disabled])

  useEffect(() => {
    let current = true
    if (!onListLocalApps) return
    onListLocalApps()
      .then(items => {
        if (!current) return
        const recentIds = new Map<string, number>(
          JSON.parse(window.localStorage.getItem(RECENT_PLUGIN_APPS_KEY) || '[]').map(
            (id: string, index: number) => [id, index]
          )
        )
        setApps(
          items
            .filter(app => app.isEnabled !== false && app.isAccessible !== false)
            .sort(
              (left, right) =>
                (recentIds.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
                (recentIds.get(right.id) ?? Number.MAX_SAFE_INTEGER)
            )
        )
      })
      .catch(() => {
        if (current) setApps([])
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [onListLocalApps])

  const visibleApps = apps.filter(app => {
    const text =
      `${app.name} ${app.description ?? ''} ${app.pluginDisplayNames?.join(' ') ?? ''}`.toLowerCase()
    return text.includes(query.trim().toLowerCase())
  })

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="composer-plugin-picker-button"
        disabled={disabled}
        aria-expanded={open}
        aria-label={t('workbench.composer_plugins', '插件')}
        className={[
          'flex h-7 items-center gap-1.5 rounded-lg text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:opacity-40',
          iconOnly ? 'w-7 justify-center px-0' : 'px-2',
        ].join(' ')}
        onClick={() => setOpen(!open)}
      >
        <Puzzle className="h-4 w-4" />
        {!iconOnly && (
          <>
            <span>{t('workbench.composer_plugins', '插件')}</span>
            {apps.slice(0, 3).map(app => {
              const logo = resolvePluginAssetUrl(app.logoUrl)
              return (
                <span
                  key={app.id}
                  className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-md border border-border bg-background"
                >
                  {logo ? (
                    <img src={logo} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Boxes className="h-3 w-3" />
                  )}
                </span>
              )
            })}
            {apps.length > 3 && <span className="text-xs text-text-muted">+{apps.length - 3}</span>}
          </>
        )}
      </button>

      {open && (
        <div
          data-testid="composer-plugin-picker"
          className="absolute bottom-9 left-0 z-popover w-[min(760px,calc(100vw-36px))] overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-xl"
        >
          <label className="relative mb-1 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              data-testid="composer-plugin-picker-search"
              className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
              placeholder={t('workbench.composer_plugin_search', '搜索插件')}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <div className="px-2 pb-1 pt-2 text-xs text-text-muted">
            {query
              ? t('workbench.composer_plugin_matches', '匹配结果')
              : t('workbench.composer_plugin_recent', '最近使用')}
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {loading ? (
              <div className="px-2 py-4 text-sm text-text-muted">
                {t('workbench.plugins_loading_plugins', '正在加载插件')}
              </div>
            ) : visibleApps.length > 0 ? (
              visibleApps.slice(0, 8).map(app => {
                const logo = resolvePluginAssetUrl(app.logoUrl)
                return (
                  <button
                    key={app.id}
                    type="button"
                    data-testid={`composer-plugin-picker-item-${app.id}`}
                    className="grid min-h-11 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
                    onClick={() => {
                      const reference = appReference(app)
                      registerComposerMentionIcon(reference, logo)
                      insertPluginReference(reference)
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
                    <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                      {logo ? (
                        <img src={logo} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Boxes className="h-4 w-4 text-text-muted" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-medium">
                        {displayAppName(app)}
                      </strong>
                      <small className="block truncate text-xs text-text-muted">
                        {app.description}
                      </small>
                    </span>
                    <CornerDownLeft className="h-4 w-4 text-text-muted" />
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
            className="mt-1 grid min-h-11 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
            onClick={() => {
              setOpen(false)
              navigateTo('/plugins')
            }}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface">
              <Boxes className="h-4 w-4 text-text-secondary" />
            </span>
            <span>
              <strong className="block text-sm font-medium">
                {t('workbench.composer_open_plugin_marketplace', '打开插件市场')}
              </strong>
              <small className="block text-xs text-text-muted">
                {t('workbench.composer_open_plugin_marketplace_hint', '浏览和搜索全部插件')}
              </small>
            </span>
            <ExternalLink className="h-4 w-4 text-text-muted" />
          </button>
        </div>
      )}
    </div>
  )
}
