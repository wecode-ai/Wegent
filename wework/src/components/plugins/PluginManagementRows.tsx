import { Globe, Sparkles, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface InstalledSkillItem {
  id: number
  name: string
  description: string
  enabled: boolean
  sourceType: 'system' | 'personal'
}

export interface InstalledMcpItem {
  id: number
  name: string
  description: string
  enabled: boolean
  serverType: string
}

export function InstalledSkillRow({
  skill,
  onToggle,
  onUninstall,
}: {
  skill: InstalledSkillItem
  onToggle: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <article className="grid grid-cols-[64px_minmax(0,1fr)_112px] items-center gap-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-indigo-50 text-indigo-500 shadow-sm">
        <Sparkles className="h-7 w-7" />
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-[17px] font-semibold leading-6">
          {skill.name}
        </h2>
        <p className="mt-1 truncate text-[15px] leading-6 text-text-secondary">
          {skill.description}
        </p>
      </div>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label={t('workbench.plugins_uninstall', '卸载')}
          data-testid={`installed-skill-uninstall-${skill.id}`}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-red-500"
          onClick={onUninstall}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={skill.enabled}
          aria-label={skill.name}
          data-testid={`installed-skill-toggle-${skill.id}`}
          className={[
            'relative h-7 w-12 rounded-full transition-colors',
            skill.enabled ? 'bg-blue-500' : 'bg-border',
          ].join(' ')}
          onClick={onToggle}
        >
          <span
            className={[
              'absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
              skill.enabled ? 'translate-x-5' : 'translate-x-0',
            ].join(' ')}
          />
        </button>
      </div>
    </article>
  )
}

export function InstalledMcpRow({
  mcp,
  onToggle,
  onUninstall,
}: {
  mcp: InstalledMcpItem
  onToggle: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <article className="grid grid-cols-[64px_minmax(0,1fr)_112px] items-center gap-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-emerald-50 text-emerald-600 shadow-sm">
        <Globe className="h-7 w-7" />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[17px] font-semibold leading-6">
            {mcp.name}
          </h2>
          <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted">
            {mcp.serverType}
          </span>
        </div>
        <p className="mt-1 truncate text-[15px] leading-6 text-text-secondary">
          {mcp.description}
        </p>
      </div>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label={t('workbench.plugins_uninstall', '卸载')}
          data-testid={`installed-mcp-uninstall-${mcp.id}`}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-red-500"
          onClick={onUninstall}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={mcp.enabled}
          aria-label={mcp.name}
          data-testid={`installed-mcp-toggle-${mcp.id}`}
          className={[
            'relative h-7 w-12 rounded-full transition-colors',
            mcp.enabled ? 'bg-blue-500' : 'bg-border',
          ].join(' ')}
          onClick={onToggle}
        >
          <span
            className={[
              'absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
              mcp.enabled ? 'translate-x-5' : 'translate-x-0',
            ].join(' ')}
          />
        </button>
      </div>
    </article>
  )
}
