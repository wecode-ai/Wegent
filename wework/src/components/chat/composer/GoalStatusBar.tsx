import { useEffect, useMemo, useState } from 'react'
import { CircleDot, Pause, Pencil, Play, Target, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeGoal, RuntimeGoalStatus } from '@/types/api'

interface GoalStatusBarProps {
  goal: RuntimeGoal
  continuing?: boolean
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
  onEditGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
  integrated = false,
}: GoalStatusBarProps) {
  const { t } = useTranslation('common')
  const statusLabel = continuing
    ? { key: 'workbench.goal_status_compact_continuing', fallback: '继续执行中' }
    : (goalStatusLabelKeys[goal.status] ?? goalStatusLabelKeys.active)
  const timerKey = goalTimerKey(goal)
  const [timerState, setTimerState] = useState(() => createTimerState(timerKey, Date.now()))
  const [actionsRevealed, setActionsRevealed] = useState(false)
  const elapsedSeconds = useMemo(
    () => getLiveElapsedSeconds(goal, timerState, timerKey),
    [goal, timerKey, timerState]
  )
  const elapsed = formatGoalElapsed(elapsedSeconds)
  const resumable = goal.status === 'paused' || goal.status === 'blocked'
  const canToggle = goal.status === 'active' || resumable
  const ToggleIcon = resumable ? Play : Pause
  const toggleLabel = resumable
    ? t('workbench.goal_start', '开始目标')
    : t('workbench.goal_pause', '暂停目标')
  const toggleAction = resumable ? onResumeGoal : onPauseGoal

  useEffect(() => {
    if (goal.status !== 'active') return

    const interval = window.setInterval(() => {
      const nowMs = Date.now()
      setTimerState(current =>
        current.key === timerKey ? { ...current, nowMs } : createTimerState(timerKey, nowMs)
      )
    }, 1000)
    return () => window.clearInterval(interval)
  }, [goal.status, timerKey])

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
        <span className="ml-1 min-w-0 truncate text-text-secondary">· {goal.objective}</span>
      </div>
      {!canToggle && (
        <span className="shrink-0 text-text-muted">{t(statusLabel.key, statusLabel.fallback)}</span>
      )}
      {elapsed && <span className="shrink-0 text-text-muted">{elapsed}</span>}
      <div
        id="goal-status-details"
        data-testid="goal-status-details"
        className="flex max-w-0 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-80 group-hover:opacity-100 group-focus-within:max-w-80 group-focus-within:opacity-100"
      >
        <button
          type="button"
          data-testid="edit-goal-button"
          onClick={onEditGoal}
          disabled={!onEditGoal}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('workbench.goal_edit', '编辑目标')}
          title={t('workbench.goal_edit', '编辑目标')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="clear-goal-button"
          onClick={onClearGoal}
          disabled={!onClearGoal}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-background/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('workbench.goal_clear', '删除目标')}
          title={t('workbench.goal_clear', '删除目标')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {canToggle && (
        <button
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
        </button>
      )}
    </div>
  )
}

interface GoalTimerState {
  key: string
  startedAtMs: number
  nowMs: number
}

function createTimerState(key: string, nowMs: number): GoalTimerState {
  return {
    key,
    startedAtMs: nowMs,
    nowMs,
  }
}

function goalTimerKey(goal: RuntimeGoal): string {
  return [goal.threadId, goal.status, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt].join(
    ':'
  )
}

function getLiveElapsedSeconds(
  goal: RuntimeGoal,
  timerState: GoalTimerState,
  timerKey: string
): number {
  const baseSeconds = Number.isFinite(goal.timeUsedSeconds)
    ? Math.max(0, Math.floor(goal.timeUsedSeconds))
    : 0
  if (goal.status !== 'active' || timerState.key !== timerKey) return baseSeconds

  return baseSeconds + Math.max(0, Math.floor((timerState.nowMs - timerState.startedAtMs) / 1000))
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
