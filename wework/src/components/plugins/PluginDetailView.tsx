import { Boxes, ChevronLeft, ExternalLink, Sparkles, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'

interface PluginDetailViewProps {
  plugin: InstalledPluginItem
  onBack: () => void
  onToggle: () => void
  onComponentToggle: (componentKey: string, enabled: boolean) => void
  onUninstall: () => void
}

interface DetailComponentItem {
  key: string
  componentKey: string
  type: string
  name: string
  description: string
}

function formatManifestValue(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') {
      const email =
        typeof record.email === 'string' && record.email
          ? ` <${record.email}>`
          : ''
      return `${record.name}${email}`
    }
    if (typeof record.url === 'string') return record.url
  }
  return ''
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return ''
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function buildComponentItems(plugin: InstalledPlugin): DetailComponentItem[] {
  const components = plugin.spec.components
  return [
    ...components.skills.map((item) => ({
      key: `skill-${item.name}`,
      componentKey: `skill:${item.name}`,
      type: 'skill',
      name: item.name,
      description: item.description || item.path,
    })),
    ...components.commands.map((item) => ({
      key: `command-${item.name}`,
      componentKey: `command:${item.name}`,
      type: 'command',
      name: item.name,
      description: item.path,
    })),
    ...components.agents.map((item) => ({
      key: `agent-${item.name}`,
      componentKey: `agent:${item.name}`,
      type: 'agent',
      name: item.name,
      description: item.path,
    })),
    ...components.hooks.map((item) => ({
      key: `hook-${item.name}`,
      componentKey: `hook:${item.name}`,
      type: 'hook',
      name: item.name,
      description: item.path,
    })),
    ...components.mcps.map((item) => ({
      key: `mcp-${item.name}`,
      componentKey: `mcp:${item.name}`,
      type: 'mcp',
      name: item.name,
      description:
        typeof item.server.description === 'string'
          ? item.server.description
          : typeof item.server.command === 'string'
            ? item.server.command
            : item.name,
    })),
    ...components.lsps.map((item) => ({
      key: `lsp-${item.name}`,
      componentKey: `lsp:${item.name}`,
      type: 'lsp',
      name: item.name,
      description: item.path,
    })),
    ...components.monitors.map((item) => ({
      key: `monitor-${item.name}`,
      componentKey: `monitor:${item.name}`,
      type: 'monitor',
      name: item.name,
      description: item.path,
    })),
    ...components.bins.map((item) => ({
      key: `bin-${item.name}`,
      componentKey: `bin:${item.name}`,
      type: 'bin',
      name: item.name,
      description: item.path,
    })),
  ]
}

function detailRows(plugin: InstalledPlugin): Array<{
  label: string
  value: string
  href?: string
}> {
  const manifest = plugin.spec.manifest
  const homepage = formatManifestValue(manifest.homepage)
  const repository = formatManifestValue(manifest.repository)
  return [
    {
      label: 'Version',
      value: plugin.spec.version || formatManifestValue(manifest.version),
    },
    {
      label: 'Author',
      value: formatManifestValue(manifest.author) || plugin.spec.author || '',
    },
    {
      label: 'Source',
      value: plugin.spec.source.type,
    },
    {
      label: 'Package',
      value: formatBytes(plugin.spec.packageRef?.sizeBytes),
    },
    {
      label: 'Homepage',
      value: homepage,
      href: homepage.startsWith('http') ? homepage : undefined,
    },
    {
      label: 'Repository',
      value: repository,
      href: repository.startsWith('http') ? repository : undefined,
    },
  ].filter((row) => row.value)
}

export function PluginDetailView({
  plugin,
  onBack,
  onToggle,
  onComponentToggle,
  onUninstall,
}: PluginDetailViewProps) {
  const { t } = useTranslation('common')
  const raw = plugin.raw
  const componentItems = buildComponentItems(raw)
  const componentStates = raw.spec.componentStates || {}
  const rows = detailRows(raw)

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-background px-4 pb-8 pt-20 text-text-primary sm:px-8 sm:py-5">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8">
        <nav
          className="flex items-center gap-2 text-sm font-semibold"
          aria-label="breadcrumb"
        >
          <button
            type="button"
            data-testid="plugin-detail-back-button"
            className="flex h-9 items-center gap-1 rounded-lg px-2 text-text-muted hover:bg-surface hover:text-text-primary"
            onClick={onBack}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('workbench.plugins_tab', '插件')}
          </button>
          <span className="text-text-muted">/</span>
          <span>{plugin.name}</span>
        </nav>

        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-border bg-violet-50 text-violet-600 shadow-sm">
              <Boxes className="h-8 w-8" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold leading-tight">
                  {plugin.name}
                </h1>
                {plugin.version && (
                  <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted">
                    {plugin.version}
                  </span>
                )}
              </div>
              <p className="mt-2 max-w-[680px] text-[15px] leading-6 text-text-secondary">
                {plugin.description}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label={t('workbench.plugins_uninstall', '卸载')}
              data-testid={`plugin-detail-uninstall-${plugin.id}`}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-red-500"
              onClick={onUninstall}
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={plugin.enabled}
              aria-label={plugin.name}
              data-testid={`plugin-detail-toggle-${plugin.id}`}
              className={[
                'relative h-7 w-12 rounded-full transition-colors',
                plugin.enabled ? 'bg-blue-500' : 'bg-border',
              ].join(' ')}
              onClick={onToggle}
            >
              <span
                className={[
                  'absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                  plugin.enabled ? 'translate-x-5' : 'translate-x-0',
                ].join(' ')}
              />
            </button>
          </div>
        </header>

        <section className="rounded-xl border border-border">
          <div className="border-b border-border bg-surface/40 px-5 py-4">
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.plugin_detail_contents', '包含内容')}
            </h2>
          </div>
          <div className="divide-y divide-border">
            {componentItems.map((item) => (
              <div
                key={item.key}
                className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-text-muted">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h3 className="truncate text-sm font-semibold">
                      {item.name}
                    </h3>
                    <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted">
                      {item.type}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-text-secondary">
                    {item.description}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={componentStates[item.componentKey] ?? true}
                  aria-label={item.name}
                  data-testid={`plugin-component-toggle-${item.componentKey}`}
                  className={[
                    'relative h-7 w-12 rounded-full transition-colors',
                    componentStates[item.componentKey] ?? true
                      ? 'bg-blue-500'
                      : 'bg-border',
                  ].join(' ')}
                  onClick={() =>
                    onComponentToggle(
                      item.componentKey,
                      !(componentStates[item.componentKey] ?? true),
                    )
                  }
                >
                  <span
                    className={[
                      'absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                      componentStates[item.componentKey] ?? true
                        ? 'translate-x-5'
                        : 'translate-x-0',
                    ].join(' ')}
                  />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border">
          <div className="border-b border-border bg-surface/40 px-5 py-4">
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.plugin_detail_info', '信息')}
            </h2>
          </div>
          <dl className="divide-y divide-border">
            {rows.map((row) => (
              <div
                key={row.label}
                className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[180px_minmax(0,1fr)]"
              >
                <dt className="font-semibold text-text-muted">{row.label}</dt>
                <dd className="min-w-0 text-text-primary">
                  {row.href ? (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    >
                      {row.value}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  )
}
