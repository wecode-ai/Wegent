import { Bot, CheckCircle2, ChevronDown, CircleAlert, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeSubagentStatus } from '@/types/workbench'

interface SubagentStatusIndicatorProps {
  statuses?: RuntimeSubagentStatus[]
  availableWidth?: number | null
  className?: string
  compact?: boolean
}

const EXPANDED_MIN_WIDTH = 720

export function SubagentStatusIndicator({
  statuses = [],
  availableWidth,
  className,
  compact = false,
}: SubagentStatusIndicatorProps) {
  const { t } = useTranslation('common')
  const [hovered, setHovered] = useState(false)
  const visibleStatuses = useMemo(() => statuses.slice(0, 4), [statuses])

  if (statuses.length === 0) return null

  const runningCount = statuses.filter(status => status.status === 'running').length
  const autoExpanded =
    !compact && typeof availableWidth === 'number' && availableWidth >= EXPANDED_MIN_WIDTH
  const panelVisible = autoExpanded || hovered
  const summary =
    runningCount > 0
      ? t('workbench.subagents_running', { count: runningCount })
      : t('workbench.subagents_count', { count: statuses.length })
  const statusLabel = (status: RuntimeSubagentStatus['status']) => {
    if (status === 'done') return t('workbench.subagent_done')
    if (status === 'interrupted') return t('workbench.subagent_interrupted')
    return t('workbench.subagent_running')
  }

  return (
    <div
      data-testid="subagent-status-hover-region"
      className={cn('relative flex shrink-0 items-center', className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <button
        type="button"
        data-testid="subagent-status-toggle-button"
        className={cn(
          'flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full border border-border/70 bg-surface px-2.5 text-xs text-text-secondary shadow-sm hover:bg-background',
          compact && 'h-9 min-w-[44px] justify-center px-2'
        )}
        aria-label={t('workbench.subagents_status')}
        aria-expanded={panelVisible}
      >
        <Bot className="h-4 w-4 shrink-0 text-primary" />
        {!compact && <span className="truncate">{summary}</span>}
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', panelVisible && 'rotate-180')}
        />
      </button>

      {panelVisible && (
        <div
          data-testid="subagent-status-panel"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-popover w-64 rounded-lg border border-border/80 bg-background p-2 shadow-lg"
        >
          <div className="mb-1 flex items-center justify-between px-1 text-xs text-text-muted">
            <span>{t('workbench.subagents_status')}</span>
            <span>{statuses.length}</span>
          </div>
          <div className="space-y-1">
            {visibleStatuses.map(status => (
              <div
                key={status.id}
                data-testid="subagent-status-item"
                className="flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface"
              >
                <SubagentStatusIcon status={status.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-text-primary" title={status.agentName}>
                    {status.agentName}
                  </span>
                  <span className="block truncate text-xs leading-4 text-text-muted">
                    {shortSubagentId(status.agentId)}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-muted">
                  {statusLabel(status.status)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SubagentStatusIcon({ status }: { status: RuntimeSubagentStatus['status'] }) {
  if (status === 'done') {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
  }
  if (status === 'interrupted') {
    return <CircleAlert className="h-4 w-4 shrink-0 text-amber-600" />
  }
  return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
}

function shortSubagentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  if (!normalized) return 'subagent'
  return normalized.length > 8 ? normalized.slice(-8) : normalized
}
