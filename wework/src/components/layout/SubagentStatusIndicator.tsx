import { Button as UiButton } from '@ui-sdk/react/button'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeSubagentStatus } from '@/types/workbench'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@wegent/collaboration/controls/HoverCard'
import { controlPopup } from '@wegent/collaboration/controls/recipes'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { Bot, CheckCircle2, ChevronDown, CircleAlert, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

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
  const [open, setOpen] = useState(false)
  const theme = useCollaborationPortalTheme()
  const visibleStatuses = useMemo(() => statuses.slice(0, 4), [statuses])

  if (statuses.length === 0) return null

  const runningCount = statuses.filter(status => status.status === 'running').length
  const autoExpanded =
    !compact && typeof availableWidth === 'number' && availableWidth >= EXPANDED_MIN_WIDTH
  const panelVisible = autoExpanded || open
  const summary =
    runningCount > 0
      ? t('workbench.subagents_running', { count: runningCount })
      : t('workbench.subagents_count', { count: statuses.length })
  const statusLabel = (status: RuntimeSubagentStatus['status']) => {
    if (status === 'done') return t('workbench.subagent_done')
    if (status === 'interrupted') return t('workbench.subagent_interrupted')
    return t('workbench.subagent_running')
  }

  const trigger = (
    <UiButton
      type="button"
      data-testid="subagent-status-toggle-button"
      className={cn(
        'min-h-11 md:min-h-8 flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full border border-border/70 bg-surface px-2.5 text-xs text-text-secondary shadow-sm hover:bg-background',
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
    </UiButton>
  )
  const panel = (
    <>
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
            <span className="shrink-0 text-xs text-text-muted">{statusLabel(status.status)}</span>
          </div>
        ))}
      </div>
    </>
  )
  if (autoExpanded)
    return (
      <div
        data-testid="subagent-status-hover-region"
        className={cn('relative flex shrink-0 items-center', className)}
      >
        {trigger}
        <div
          {...theme}
          data-testid="subagent-status-panel"
          className={cn(
            theme.className,
            controlPopup,
            'absolute right-0 top-[calc(100%+0.5rem)] w-64 p-2'
          )}
        >
          {panel}
        </div>
      </div>
    )
  return (
    <div
      data-testid="subagent-status-hover-region"
      className={cn('flex shrink-0 items-center', className)}
    >
      <HoverCard open={open} onOpenChange={setOpen} delay={0} closeDelay={120}>
        <HoverCardTrigger render={trigger} />
        <HoverCardContent
          {...theme}
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          data-testid="subagent-status-panel"
          className={cn(theme.className, controlPopup, 'w-64 p-2')}
        >
          {panel}
        </HoverCardContent>
      </HoverCard>
    </div>
  )
}

function SubagentStatusIcon({ status }: { status: RuntimeSubagentStatus['status'] }) {
  if (status === 'done') {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-success wework:text-emerald-600" />
  }
  if (status === 'interrupted') {
    return <CircleAlert className="h-4 w-4 shrink-0 text-warning wework:text-amber-600" />
  }
  return <CompositedSpinner icon={Loader2} className="h-4 w-4 text-primary" />
}

function shortSubagentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  if (!normalized) return 'subagent'
  return normalized.length > 8 ? normalized.slice(-8) : normalized
}
