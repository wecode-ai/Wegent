import { FolderOpen, Pencil, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { HookTestResult } from './HookTestResult'
import type { HookRunSummary, ResolvedHookPlugin } from './hooksTypes'

export function HookListItem({
  plugin,
  onEnabled,
  onEdit,
  onDelete,
  onReveal,
  onTest,
}: {
  plugin: ResolvedHookPlugin
  onEnabled: (enabled: boolean) => Promise<void>
  onEdit: () => void
  onDelete: () => Promise<void>
  onReveal: () => Promise<void>
  onTest: (handlerId: string) => Promise<HookRunSummary>
}) {
  const { t } = useTranslation('hooks')
  const [testRun, setTestRun] = useState<HookRunSummary | null>(null)
  const [testing, setTesting] = useState(false)
  const health = typeof plugin.health === 'string' ? plugin.health : plugin.health.status
  const recentRun = plugin.recentRuns[0]

  const runTest = async () => {
    const handler = plugin.handlers[0]
    if (!handler || testing) return
    setTesting(true)
    try {
      setTestRun(await onTest(handler.id))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div data-testid={`hook-row-${plugin.manifest.id}`} className="px-4 py-3">
      <div className="flex min-w-0 items-center justify-between gap-4 max-sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-text-primary">
              {plugin.manifest.name}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
              {t(`source_${plugin.source}`)}
            </span>
            <span className="shrink-0 text-xs text-text-muted">{t(`health_${health}`)}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-secondary">
            <span>v{plugin.manifest.version}</span>
            {plugin.manifest.description && (
              <span className="truncate">{plugin.manifest.description}</span>
            )}
            {recentRun && !testRun && (
              <span className="truncate text-text-muted">
                · {t('last_run')} {t(`run_${recentRun.status}`)} · {recentRun.durationMs} ms
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <SettingsSwitch
            data-testid={`hook-enabled-${plugin.manifest.id}`}
            checked={plugin.enabled}
            disabled={!plugin.policy.canDisable}
            onCheckedChange={value => void onEnabled(value)}
            aria-label={t('enabled')}
          />
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
            onClick={() => void onReveal()}
            aria-label={t('reveal')}
          >
            <FolderOpen className="h-4 w-4" />
          </button>
          {plugin.policy.canEdit && (
            <button
              data-testid={`hook-menu-${plugin.manifest.id}`}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
              onClick={onEdit}
              aria-label={t('edit')}
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {plugin.handlers[0] && (
            <button
              data-testid="hook-test-run"
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-40"
              onClick={() => void runTest()}
              disabled={testing}
              aria-label={t('test')}
            >
              <Play className="h-4 w-4" />
            </button>
          )}
          {plugin.policy.canDelete && (
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10"
              onClick={() => void onDelete()}
              aria-label={t('delete')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {testRun && <HookTestResult run={testRun} />}
    </div>
  )
}
