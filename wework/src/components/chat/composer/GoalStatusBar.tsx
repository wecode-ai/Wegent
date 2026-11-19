import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import type { ConnectionGoalWaitState } from '@/lib/runtime-connection-events'
import type { RuntimeGoal, RuntimeGoalExecutionStatus, RuntimeGoalStatus } from '@/types/api'
import { useClock } from '@wegent/collaboration/clock'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { CircleDot, Pause, Pencil, Play, Target } from 'lucide-react'
import { useState } from 'react'

interface GoalStatusBarProps {
  goal: RuntimeGoal
  continuing?: boolean
  executionStatus?: RuntimeGoalExecutionStatus | null
  eventWaitState?: ConnectionGoalWaitState
  onEditGoal?: () => void
  onPauseGoal?: () => void
  onResumeGoal?: () => void
  onClearGoal?: () => void
  integrated?: boolean
}

const goalStatusLabelKeys: Record<RuntimeGoalStatus, { key: string; fallback: string }> = {
  active: { key: 'workbench.goal_status_compact_active', fallback: '进行中' },
  paused: { key: 'workbench.goal_status_compact_paused', fallback: '已暂停' },
  blocked: { key: 'workbench.goal_status_compact_blocked', fallback: '受阻' },
  complete: { key: 'workbench.goal_status_compact_complete', fallback: '已完成' },
  usageLimited: { key: 'workbench.goal_status_compact_usage_limited', fallback: '用量受限' },
  budgetLimited: { key: 'workbench.goal_status_compact_budget_limited', fallback: '预算受限' },
}

export function GoalStatusBar({
  goal,
  continuing = false,
  executionStatus = null,
  eventWaitState,
  onEditGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
  integrated = false,
}: GoalStatusBarProps) {
  const { t } = useTranslation('common')
  const waitingForEvent = Boolean(eventWaitState) && executionStatus !== 'needsAttention'
  const statusLabel =
    executionStatus === 'needsAttention'
      ? { key: 'workbench.goal_status_compact_needs_attention', fallback: '需要恢复' }
      : executionStatus === 'recovering'
        ? { key: 'workbench.goal_status_compact_recovering', fallback: '正在恢复' }
        : waitingForEvent && goal.status === 'blocked'
          ? eventWaitState === 'received'
            ? { key: 'workbench.goal_status_waiting_execution', fallback: '等待继续执行' }
            : { key: 'workbench.goal_status_waiting_event', fallback: '等待事件' }
          : continuing
            ? { key: 'workbench.goal_status_compact_continuing', fallback: '正在开始下一轮' }
            : (goalStatusLabelKeys[goal.status] ?? goalStatusLabelKeys.active)
  const [actionsRevealed, setActionsRevealed] = useState(false)
  const resumable =
    goal.status === 'paused' ||
    (goal.status === 'blocked' && !waitingForEvent) ||
    executionStatus === 'needsAttention'
  const canToggle =
    goal.status === 'active' || resumable || (goal.status === 'blocked' && waitingForEvent)
  const showStatus =
    goal.status === 'paused' ||
    goal.status === 'blocked' ||
    waitingForEvent ||
    !canToggle ||
    continuing ||
    executionStatus !== null
  const ToggleIcon = resumable ? Play : Pause
  const toggleLabel = resumable
    ? t('workbench.goal_start', '开始目标')
    : t('workbench.goal_pause', '暂停目标')
  const toggleAction = resumable ? onResumeGoal : onPauseGoal

  return (
    <div
      data-testid="goal-status-bar"
      onMouseEnter={() => setActionsRevealed(true)}
      onMouseLeave={() => setActionsRevealed(false)}
      onFocus={() => setActionsRevealed(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActionsRevealed(false)
      }}
      className={[
        'group flex h-8 min-w-0 items-center gap-1.5 overflow-hidden px-2.5 text-xs text-text-secondary',
        integrated
          ? 'w-full max-w-none transition-colors hover:bg-background/55 focus-within:bg-background/55'
          : 'shrink rounded-xl border border-border/60 bg-muted/55 transition-[max-width,background-color] duration-200 hover:max-w-[560px] hover:bg-muted focus-within:max-w-[560px] focus-within:bg-muted',
      ].join(' ')}
    >
      <Target className="h-4 w-4 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 items-center">
        <span className="shrink-0 font-semibold text-text-primary">
          {t('workbench.goal_chip', '目标')}
        </span>
        <Tooltip
          label={goal.objective}
          align="start"
          testId="goal-objective-tooltip"
          className="ml-1 min-w-0 flex-1 shrink overflow-hidden"
        >
          <span data-testid="goal-objective" className="block min-w-0 truncate text-text-secondary">
            · {goal.objective}
          </span>
        </Tooltip>
      </div>
      {showStatus && (
        <span className="shrink-0 text-text-muted">{t(statusLabel.key, statusLabel.fallback)}</span>
      )}
      <GoalElapsedTime key={goalTimerKey(goal)} goal={goal} />
      <div
        id="goal-status-details"
        data-testid="goal-status-details"
        className="flex max-w-0 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-80 group-hover:opacity-100 group-focus-within:max-w-80 group-focus-within:opacity-100"
      >
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="edit-goal-button"
          onClick={onEditGoal}
          disabled={!onEditGoal}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('workbench.goal_edit', '编辑目标')}
          title={t('workbench.goal_edit', '编辑目标')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </ControlButton>
        <DeleteIconButton
          type="button"
          data-testid="clear-goal-button"
          onClick={onClearGoal}
          disabled={!onClearGoal}
          aria-label={t('workbench.goal_clear', '删除目标')}
          title={t('workbench.goal_clear', '删除目标')}
          density="compact"
        />
      </div>
      {canToggle && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={resumable ? 'resume-goal-button' : 'pause-goal-button'}
          onClick={toggleAction}
          disabled={!toggleAction}
          className="group/goal-toggle flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          {resumable ? (
            <ToggleIcon className="h-3.5 w-3.5" />
          ) : (
            <span className="relative inline-flex h-3.5 w-3.5">
              <CircleDot
                data-testid="goal-running-icon"
                className={[
                  'absolute inset-0 h-3.5 w-3.5 text-primary transition-opacity',
                  actionsRevealed ? 'opacity-0' : 'opacity-100',
                ].join(' ')}
              />
              <Pause
                data-testid="goal-pause-icon"
                className={[
                  'absolute inset-0 h-3.5 w-3.5 transition-opacity',
                  actionsRevealed ? 'opacity-100' : 'opacity-0',
                ].join(' ')}
              />
            </span>
          )}
        </ControlButton>
      )}
    </div>
  )
}

function GoalElapsedTime({ goal }: { goal: RuntimeGoal }) {
  const [startedAtMs] = useState(() => Date.now())
  const nowMs = useClock(goal.status === 'active')
  const baseSeconds = Number.isFinite(goal.timeUsedSeconds)
    ? Math.max(0, Math.floor(goal.timeUsedSeconds))
    : 0
  const liveSeconds =
    goal.status === 'active' ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)) : 0
  return (
    <span className="shrink-0 text-text-muted">{formatGoalElapsed(baseSeconds + liveSeconds)}</span>
  )
}

function goalTimerKey(goal: RuntimeGoal): string {
  return [goal.threadId, goal.status, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt].join(
    ':'
  )
}

function formatGoalElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`
  }
  return `${remainingSeconds}s`
}
