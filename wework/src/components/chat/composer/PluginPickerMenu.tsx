import { Boxes, ExternalLink, Puzzle, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { getRuntimeConfig } from '@/config/runtime'
import { queuePluginTrial } from '@/features/plugins/pluginTrial'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { InstalledPlugin } from '@/types/api'
import { resolvePluginAssetUrl } from '@/components/plugins/plugin-assets'

interface PluginPickerMenuProps {
  disabled?: boolean
  iconOnly?: boolean
}

function pluginId(plugin: InstalledPlugin): string {
  const labels = plugin.metadata.labels
  if (labels && typeof labels === 'object' && 'id' in labels) {
    return String((labels as Record<string, unknown>).id)
  }
  return `${plugin.metadata.namespace}:${plugin.metadata.name}`
}

export function PluginPickerMenu({ disabled = false, iconOnly = false }: PluginPickerMenuProps) {
  const { t } = useTranslation('common')
  const rootRef = useRef<HTMLDivElement>(null)
  const api = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createPluginApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    let current = true
    api
      .listInstalledPlugins()
      .then(response => {
        if (current) setPlugins(response.items.filter(plugin => plugin.spec.enabled))
      })
      .catch(() => {
        if (current) setPlugins([])
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [api, open])

  const visiblePlugins = plugins.filter(plugin => {
    const text = `${plugin.spec.displayName} ${plugin.spec.description}`.toLowerCase()
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
        onClick={() => {
          if (!open) setLoading(true)
          setOpen(!open)
        }}
      >
        <Puzzle className="h-4 w-4" />
        {!iconOnly && <span>{t('workbench.composer_plugins', '插件')}</span>}
      </button>

      {open && (
        <div
          data-testid="composer-plugin-picker"
          className="absolute bottom-9 left-0 z-popover w-[430px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-xl"
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
            ) : (
              visiblePlugins.slice(0, 8).map(plugin => {
                const logo = resolvePluginAssetUrl(
                  plugin.spec.interface?.composerIcon || plugin.spec.interface?.logo
                )
                return (
                  <button
                    key={pluginId(plugin)}
                    type="button"
                    data-testid={`composer-plugin-picker-item-${pluginId(plugin)}`}
                    className="grid min-h-11 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted"
                    onClick={() => {
                      if (queuePluginTrial(plugin)) setOpen(false)
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
                        {plugin.spec.displayName || plugin.spec.source.pluginKey}
                      </strong>
                      <small className="block truncate text-xs text-text-muted">
                        {plugin.spec.description}
                      </small>
                    </span>
                    <span className="text-xs text-text-muted">
                      {t('workbench.composer_plugin_add', '添加')}
                    </span>
                  </button>
                )
              })
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
