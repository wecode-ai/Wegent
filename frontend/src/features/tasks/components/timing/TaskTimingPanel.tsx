'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  Clock,
  Loader2,
  RotateCcw,
  Timer,
  X,
} from 'lucide-react'
import { taskApis, type TaskTimingResponse } from '@/apis/tasks'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  openTaskRightPanel,
  registerTaskRightPanel,
  type TaskRightPanelComponentProps,
} from '@/features/tasks/components/right-panel'
import { useTranslation } from '@/hooks/useTranslation'

export const TASK_TIMING_PANEL_TYPE = 'task-timing'

type FetchState =
  | { status: 'loading' }
  | { status: 'success'; data: TaskTimingResponse }
  | { status: 'empty' }
  | { status: 'error'; message: string }

type TaskTimingPanelProps = TaskRightPanelComponentProps<{ taskId: number }>

interface TimelineBounds {
  start?: number
  end?: number
  observedStart?: number
  observedEnd?: number
}

let timingPanelRegistered = false

/** Register the panel when its user-triggered entry point is first used. */
export function registerTaskTimingPanel(): void {
  if (timingPanelRegistered) return
  registerTaskRightPanel(TASK_TIMING_PANEL_TYPE, TaskTimingPanel)
  timingPanelRegistered = true
}

export function openTaskTimingPanel(taskId: number): void {
  registerTaskTimingPanel()
  openTaskRightPanel({
    panelType: TASK_TIMING_PANEL_TYPE,
    panelProps: { taskId },
  })
}

export function TaskTimingPanel({ panelProps, onClose }: TaskTimingPanelProps) {
  const { t } = useTranslation('tasks')
  const [state, setState] = useState<FetchState>({ status: 'loading' })
  const requestScopeRef = useRef(0)

  const loadTiming = useCallback(
    async (taskId: number) => {
      const requestScope = ++requestScopeRef.current
      const isCurrentRequest = () => requestScopeRef.current === requestScope

      setState({ status: 'loading' })
      try {
        const data = await taskApis.getTaskTiming(taskId)
        if (!isCurrentRequest()) return
        setState(
          data.spans.length === 0 || data.has_spans === false
            ? { status: 'empty' }
            : { status: 'success', data }
        )
      } catch (error) {
        if (!isCurrentRequest()) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : t('timing.errors.load_failed'),
        })
      }
    },
    [t]
  )

  useEffect(() => {
    void loadTiming(panelProps.taskId)
  }, [loadTiming, panelProps.taskId])

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-base text-text-primary"
      data-testid="task-timing-panel"
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Timer className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{t('timing.title')}</h2>
            <p className="truncate text-xs text-text-muted">{t('timing.subtitle')}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={t('timing.close')}
          className="h-11 w-11 shrink-0 text-text-muted hover:text-text-primary"
          data-testid="task-timing-close"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {state.status === 'loading' ? (
          <TimingState
            icon={<Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />}
            title={t('timing.loading.title')}
            description={t('timing.loading.description')}
            testId="task-timing-loading"
          />
        ) : null}

        {state.status === 'empty' ? (
          <TimingState
            icon={<BarChart3 className="h-5 w-5 text-text-muted" aria-hidden="true" />}
            title={t('timing.empty.title')}
            description={t('timing.empty.description')}
            testId="task-timing-empty"
          />
        ) : null}

        {state.status === 'error' ? (
          <div
            role="alert"
            className="rounded-lg border border-border bg-surface p-4"
            data-testid="task-timing-error"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
              {t('timing.error.title')}
            </div>
            <p className="mt-1 break-words text-xs text-text-muted">{state.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 min-h-11"
              onClick={() => void loadTiming(panelProps.taskId)}
              data-testid="task-timing-retry"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('timing.error.retry')}
            </Button>
          </div>
        ) : null}

        {state.status === 'success' ? <TimingContent data={state.data} /> : null}
      </div>
    </section>
  )
}

function TimingContent({ data }: { data: TaskTimingResponse }) {
  const { t } = useTranslation('tasks')
  const hasTimeline = data.spans.length > 0

  return (
    <div className="space-y-4">
      <section aria-labelledby="task-timing-summary-title" data-testid="task-timing-summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            id="task-timing-summary-title"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <Clock className="h-4 w-4 text-text-muted" aria-hidden="true" />
            {t('timing.summary.title')}
          </h3>
          <span
            className="rounded bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
            data-testid="task-timing-wall-time"
          >
            {t('timing.summary.wall_time', {
              duration: formatDuration(data.wall_time_ms),
            })}
          </span>
        </div>

        <ul className="mt-3 space-y-2" data-testid="task-timing-triage">
          {data.triage.map(category => (
            <li key={category.kind} data-testid="task-timing-triage-item">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                  {t(`timing.summary.${category.kind}`)}
                </span>
                <span className="shrink-0 text-xs font-medium tabular-nums text-text-primary">
                  {formatDuration(category.duration_ms)}
                </span>
              </div>
              <DurationBar
                durationMs={category.duration_ms}
                totalMs={data.wall_time_ms ?? categoryTotal(data.triage)}
              />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="task-timing-suspects-title" data-testid="task-timing-suspects">
        <h3 id="task-timing-suspects-title" className="text-sm font-semibold">
          {t('timing.suspects.title')}
        </h3>
        <div className="mt-3 space-y-3">
          {data.top_suspects.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface p-3 text-xs text-text-muted">
              {t('timing.suspects.empty')}
            </p>
          ) : (
            data.top_suspects.slice(0, 5).map(suspect => (
              <article
                key={suspect.span_id}
                className="rounded-lg border border-border bg-surface p-3"
                data-testid="task-timing-suspect"
              >
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {suspect.label}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {t('timing.suspects.meta', {
                        category: suspect.category,
                        status: suspect.status,
                      })}
                    </p>
                  </div>
                  <span className="shrink-0 self-start rounded bg-primary/10 px-2 py-1 text-xs font-medium tabular-nums text-primary">
                    {formatDuration(suspect.duration_ms)}
                  </span>
                </div>
                <p className="mt-2 break-words text-xs text-text-secondary">
                  {t(`timing.suggestions.${suspect.suggestion}`, {
                    defaultValue: suspect.suggestion,
                  })}
                </p>
              </article>
            ))
          )}
        </div>
      </section>

      <section aria-labelledby="task-timing-timeline-title" data-testid="task-timing-timeline">
        <Collapsible disabled={!hasTimeline}>
          <CollapsibleTrigger
            className="flex h-11 w-full items-center justify-between rounded-lg px-2 text-left text-sm font-medium text-text-primary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="task-timing-timeline-toggle"
          >
            <span className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-text-muted" aria-hidden="true" />
              {t('timing.timeline.title')}
            </span>
            {hasTimeline ? (
              <ChevronDown
                className="h-4 w-4 shrink-0 text-text-muted transition-transform data-[state=closed]:-rotate-90"
                aria-hidden="true"
              />
            ) : (
              <span className="text-xs font-normal text-text-muted">
                {t('timing.timeline.empty')}
              </span>
            )}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <TimelineDetails data={data} />
          </CollapsibleContent>
        </Collapsible>
      </section>
    </div>
  )
}

function TimelineDetails({ data }: { data: TaskTimingResponse }) {
  const { t } = useTranslation('tasks')
  const { spans } = data
  const bounds = useTimelineBounds(data)
  const gaps = useMemo(() => unobservedIntervals(data, bounds), [data, bounds])
  const leadingGap =
    bounds.start !== undefined && gaps[0]?.start === bounds.start ? gaps[0].end - gaps[0].start : 0
  const trailingGap =
    bounds.end !== undefined && gaps.length > 0 && gaps.at(-1)?.end === bounds.end
      ? gaps.at(-1)!.end - gaps.at(-1)!.start
      : 0
  const interiorGaps = gaps.filter(
    (gap, index) =>
      !(bounds.start !== undefined && index === 0 && gap.start === bounds.start) &&
      !(bounds.end !== undefined && gap.end === bounds.end)
  )

  return (
    <div className="mt-2 space-y-3" data-testid="task-timing-timeline-details">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="truncate">{formatTimestamp(bounds.start)}</span>
        <span className="h-px min-w-4 flex-1 bg-border" />
        <span className="truncate">{formatTimestamp(bounds.end)}</span>
      </div>
      <div
        className="relative h-3 w-full overflow-hidden rounded-full bg-muted"
        data-testid="task-timing-session-track"
        role="presentation"
      >
        <span
          className="absolute inset-y-0 left-0 bg-border"
          style={{ width: percent(leadingGap, bounds) }}
          data-testid="task-timing-leading-gap"
        />
        <span
          className="absolute inset-y-0 right-0 bg-border"
          style={{ width: percent(trailingGap, bounds) }}
          data-testid="task-timing-trailing-gap"
        />
        {interiorGaps.map(gap => (
          <span
            key={`gap-${gap.start}-${gap.end}`}
            className="absolute inset-y-0 bg-border"
            style={gapPosition(gap, bounds)}
            data-testid="task-timing-interior-gap"
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {leadingGap > 0 ? (
          <span
            className="rounded bg-surface px-2 py-1 text-xs text-text-muted"
            data-testid="task-timing-leading-gap-label"
          >
            {t('timing.timeline.leading_gap', { duration: formatDuration(leadingGap) })}
          </span>
        ) : null}
        {trailingGap > 0 ? (
          <span
            className="rounded bg-surface px-2 py-1 text-xs text-text-muted"
            data-testid="task-timing-trailing-gap-label"
          >
            {t('timing.timeline.trailing_gap', { duration: formatDuration(trailingGap) })}
          </span>
        ) : null}
        {interiorGaps.map(gap => (
          <span
            key={`gap-label-${gap.start}-${gap.end}`}
            className="rounded bg-surface px-2 py-1 text-xs text-text-muted"
            data-testid="task-timing-interior-gap-label"
          >
            {t('timing.timeline.interior_gap', { duration: formatDuration(gap.end - gap.start) })}
          </span>
        ))}
      </div>

      {spans.map(span => (
        <article
          key={span.id}
          className="rounded-lg border border-border bg-surface p-3"
          data-testid="task-timing-span"
        >
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="min-w-0 truncate text-sm font-medium text-text-primary">
                  {span.actor_label || span.kind}
                </p>
                <span
                  className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase text-text-muted"
                  data-testid="task-timing-span-status"
                >
                  {t(`timing.status.${span.status}`, { defaultValue: span.status })}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-text-muted">
                {t('timing.timeline.span_meta', {
                  kind: span.kind,
                  turn: span.turn_id,
                  duration: formatDuration(span.duration_ms),
                })}
              </p>
            </div>
            <span className="shrink-0 text-xs text-text-muted sm:text-right">
              {formatTimestamp(span.start_at_ms)} → {formatTimestamp(span.end_at_ms)}
            </span>
          </div>
          <div
            className="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
            data-testid="task-timing-span-bar-track"
            role="presentation"
          >
            <span
              className="absolute inset-y-0 rounded-full bg-primary/70"
              style={barPosition(span, bounds)}
              data-testid="task-timing-span-bar"
            />
          </div>
        </article>
      ))}
    </div>
  )
}

function TimingState({
  icon,
  title,
  description,
  testId,
}: {
  icon: ReactNode
  title: string
  description: string
  testId: string
}) {
  return (
    <div
      className="rounded-lg border border-border bg-surface p-6 text-center"
      data-testid={testId}
    >
      <div className="flex justify-center">{icon}</div>
      <p className="mt-3 text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-1 text-xs text-text-muted">{description}</p>
    </div>
  )
}

function DurationBar({ durationMs, totalMs }: { durationMs: number; totalMs: number }) {
  const width = Math.max((durationMs / Math.max(totalMs, 1)) * 100, 1)
  return (
    <span
      className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="presentation"
    >
      <span className="block h-full rounded-full bg-primary/70" style={{ width: `${width}%` }} />
    </span>
  )
}

export function categoryTotal(categories: TaskTimingResponse['triage']): number {
  return categories.reduce((total, category) => total + category.duration_ms, 0)
}

function useTimelineBounds(data: TaskTimingResponse): TimelineBounds {
  return useMemo(() => {
    const sessionStart = validTimestamp(data.session_start_at_ms)
    const sessionEnd = validTimestamp(data.session_end_at_ms)
    let observedStart = Number.POSITIVE_INFINITY
    let observedEnd = Number.NEGATIVE_INFINITY

    for (const span of data.spans) {
      if (span.start_at_ms === null || span.start_at_ms === undefined) continue
      const spanEnd =
        span.end_at_ms ??
        (span.duration_ms === null || span.duration_ms === undefined
          ? span.start_at_ms
          : span.start_at_ms + span.duration_ms)
      observedStart = Math.min(observedStart, span.start_at_ms)
      observedEnd = Math.max(observedEnd, spanEnd)
    }

    const hasObservedSpans = Number.isFinite(observedStart) && Number.isFinite(observedEnd)
    const fallbackStart = hasObservedSpans ? observedStart : undefined
    const fallbackEnd = hasObservedSpans ? observedEnd : undefined
    const start = sessionStart ?? fallbackStart
    const end = sessionEnd ?? fallbackEnd

    if (start === undefined || end === undefined || end < start) {
      return { start, end: start, observedStart: undefined, observedEnd: undefined }
    }
    return {
      start,
      end,
      observedStart: hasObservedSpans ? observedStart : undefined,
      observedEnd: hasObservedSpans ? observedEnd : undefined,
    }
  }, [data])
}

function unobservedIntervals(
  data: TaskTimingResponse,
  bounds: TimelineBounds
): Array<{ start: number; end: number }> {
  if (bounds.start === undefined || bounds.end === undefined) return []
  const intervals = data.spans
    .map(span => {
      if (span.start_at_ms === null || span.start_at_ms === undefined) return undefined
      const fallbackEnd =
        span.duration_ms === null || span.duration_ms === undefined
          ? span.start_at_ms
          : span.start_at_ms + span.duration_ms
      return [span.start_at_ms, span.end_at_ms ?? fallbackEnd] as const
    })
    .filter((interval): interval is readonly [number, number] => interval !== undefined)
    .filter(([start, end]) => end > start)
    .map(([start, end]) => [Math.max(start, bounds.start!), Math.min(end, bounds.end!)])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0])

  const gaps: Array<{ start: number; end: number }> = []
  let cursor = bounds.start
  for (const [start, end] of intervals) {
    if (start > cursor) gaps.push({ start: cursor, end: start })
    cursor = Math.max(cursor, end)
  }
  if (cursor < bounds.end) gaps.push({ start: cursor, end: bounds.end })
  return gaps
}

function barPosition(
  span: TaskTimingResponse['spans'][number],
  bounds: TimelineBounds
): { left: string; width: string } {
  if (bounds.start === undefined || bounds.end === undefined || span.start_at_ms == null) {
    return { left: '0%', width: '0%' }
  }
  const start = span.start_at_ms ?? bounds.start
  const fallbackEnd =
    span.duration_ms === null || span.duration_ms === undefined ? start : start + span.duration_ms
  const end = span.end_at_ms ?? fallbackEnd
  const scale = bounds.end - bounds.start
  const left = Math.max(start - bounds.start, 0)
  const width = Math.max(Math.min(end - start, scale - left), end === start ? 0 : 1)
  return {
    left: `${(left / Math.max(scale, 1)) * 100}%`,
    width: `${(width / Math.max(scale, 1)) * 100}%`,
  }
}

function percent(durationMs: number, bounds: TimelineBounds): string {
  if (bounds.start === undefined || bounds.end === undefined) return '0%'
  const scale = Math.max(bounds.end - bounds.start, 1)
  return `${Math.max(Math.min(durationMs / scale, 1), 0) * 100}%`
}

function gapPosition(gap: { start: number; end: number }, bounds: TimelineBounds) {
  if (bounds.start === undefined || bounds.end === undefined) return { left: '0%', width: '0%' }
  const scale = Math.max(bounds.end - bounds.start, 1)
  return {
    left: `${((gap.start - bounds.start) / scale) * 100}%`,
    width: `${((gap.end - gap.start) / scale) * 100}%`,
  }
}

function validTimestamp(timestampMs?: number | null): number | undefined {
  return timestampMs === null || timestampMs === undefined ? undefined : timestampMs
}

function formatDuration(durationMs?: number | null): string {
  if (durationMs === null || durationMs === undefined) return '--'
  if (durationMs < 1000) return `${Math.max(durationMs, 0)}ms`
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(seconds / 3600)
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`
}

function formatTimestamp(timestampMs?: number | null): string {
  if (timestampMs === null || timestampMs === undefined) return '--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs))
}
