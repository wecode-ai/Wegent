'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, BarChart3, Loader2, RotateCcw, Timer, X } from 'lucide-react'
import { taskApis, type TaskTimingResponse } from '@/apis/tasks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  openTaskRightPanel,
  registerTaskRightPanel,
  type TaskRightPanelComponentProps,
} from '@/features/tasks/components/right-panel'
import { useTranslation } from '@/hooks/useTranslation'
import type { TimingSpan } from './timing-types'
import type { TimelineBounds } from './timing-types'
import {
  buildMarkdownReport,
  buildTimelineTracks,
  categoryBackground,
  categoryDot,
  categoryTotal,
  formatDuration,
  formatTimestamp,
  intervalPosition,
  isOpenSpan,
  percentValue,
  spanDuration,
  spanInterval,
  spanTooltip,
  statusVariant,
  timelineBounds,
  timelineCategory,
  unobservedBackground,
  unobservedIntervals,
  useTimelineBounds,
} from './timeline-utils'

const LEGEND_CATEGORY_ORDER = [
  'agent',
  'subagent',
  'tool',
  'waiting_user',
  'runtime',
  'other',
  'gap',
]
const DEFAULT_VISIBLE_SPANS = 20

let timingPanelRegistered = false

export const TASK_TIMING_PANEL_TYPE = 'task-timing'

type FetchState =
  | { status: 'loading' }
  | { status: 'success'; data: TaskTimingResponse }
  | { status: 'empty' }
  | { status: 'error'; message: string }

type TaskTimingPanelProps = TaskRightPanelComponentProps<{ taskId: number }>
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

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const reportRef = useRef<HTMLTextAreaElement | null>(null)
  const copyReport = useCallback(async () => {
    const data = state.status === 'success' ? state.data : null
    if (!data) return
    const bounds = timelineBounds(data)
    const gaps = unobservedIntervals(data, bounds)
    const report = buildMarkdownReport(data, bounds, gaps)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report)
        setCopyState('copied')
        return
      }
      throw new Error('Clipboard API unavailable')
    } catch {
      const input = reportRef.current
      if (!input) {
        setCopyState('failed')
        return
      }
      input.value = report
      input.select()
      const copied = document.execCommand('copy')
      input.value = ''
      setCopyState(copied ? 'copied' : 'failed')
    }
  }, [state])

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-base text-text-primary"
      data-testid="task-timing-panel"
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Timer className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{t('timing.title')}</h2>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => void copyReport()}
            disabled={state.status !== 'success'}
            data-testid="task-timing-copy-report"
          >
            {copyState === 'copied'
              ? t('timing.report.copied')
              : copyState === 'failed'
                ? t('timing.report.copy_failed')
                : t('timing.report.copy')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void loadTiming(panelProps.taskId)}
            aria-label={t('timing.refresh')}
            className="h-11 w-11 text-text-muted hover:text-text-primary"
            data-testid="task-timing-refresh"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </Button>
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
        </div>
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
      <textarea ref={reportRef} className="sr-only" aria-hidden="true" readOnly tabIndex={-1} />
    </section>
  )
}

function TimingContent({ data }: { data: TaskTimingResponse }) {
  const { t } = useTranslation('tasks')
  const bounds = useTimelineBounds(data)
  const gaps = useMemo(() => unobservedIntervals(data, bounds), [data, bounds])
  const wallTime = data.wall_time_ms ?? categoryTotal(data.triage)
  const observedMs = data.observed_ms ?? Math.max(wallTime - (data.unobserved_ms ?? 0), 0)
  const coverage = percentValue(observedMs, wallTime)
  const legendCategories = LEGEND_CATEGORY_ORDER.map(kind => {
    const category = data.triage.find(candidate => candidate.kind === kind)
    return category ?? { kind, duration_ms: 0, sample_count: 0, observed: false }
  })
  const attributionCategories = legendCategories.filter(
    category => category.kind !== 'gap' && category.observed && category.duration_ms > 0
  )
  const gapCategory = legendCategories.find(category => category.kind === 'gap')

  return (
    <div className="space-y-6">
      <section
        className="rounded-lg border border-border bg-surface p-3"
        aria-labelledby="task-timing-summary-title"
        data-testid="task-timing-summary"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <h3
              id="task-timing-summary-title"
              className="border-l-2 border-primary pl-2 text-xs font-semibold uppercase tracking-wide text-text-primary"
            >
              {t('timing.summary.title')}
            </h3>
            <p className="mt-1 text-xs text-text-muted" data-testid="task-timing-window">
              {formatTimestamp(data.session_start_at_ms)} →{' '}
              {formatTimestamp(data.session_end_at_ms)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span
              className="rounded bg-primary/10 px-2 py-1 text-xs font-medium tabular-nums text-primary"
              data-testid="task-timing-wall-time"
            >
              {formatDuration(wallTime)}
            </span>
            <Badge variant="secondary" size="sm" data-testid="task-timing-status">
              {t(`timing.status.${data.task_status}`, { defaultValue: data.task_status })}
            </Badge>
          </div>
        </div>

        <div
          className="mt-3 flex h-2 w-full overflow-hidden bg-muted"
          data-testid="task-timing-attribution-bar"
          role="presentation"
        >
          {attributionCategories.map(category => (
            <span
              key={category.kind}
              className={categoryBackground(category.kind)}
              style={{ width: `${percentValue(category.duration_ms, wallTime)}%` }}
              data-testid="task-timing-attribution-segment"
              data-kind={category.kind}
            />
          ))}
          {gapCategory && gapCategory.duration_ms > 0 ? (
            <span
              className={`h-full ${unobservedBackground()}`}
              style={{ width: `${percentValue(gapCategory.duration_ms, wallTime)}%` }}
              data-testid="task-timing-attribution-segment"
              data-kind="gap"
            />
          ) : null}
        </div>

        <div className="mt-3 space-y-1.5" data-testid="task-timing-legend">
          {legendCategories
            .filter(
              category =>
                (category.observed && category.duration_ms > 0) ||
                (category.kind === 'gap' && category.duration_ms > 0)
            )
            .map(category => (
              <div
                key={category.kind}
                className="flex items-center gap-2 text-xs"
                data-testid="task-timing-legend-item"
                data-kind={category.kind}
                title={t(`timing.categories.${category.kind}.description`, {
                  defaultValue: category.kind,
                })}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${categoryDot(category.kind)}`} />
                <span className="w-24 shrink-0 truncate font-medium text-text-primary">
                  {t(`timing.summary.${category.kind}`, { defaultValue: category.kind })}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-muted">
                  {t(`timing.categories.${category.kind}.example`, { defaultValue: '' })}
                </span>
                <span className="w-16 shrink-0 text-right font-mono tabular-nums text-text-primary">
                  {formatDuration(category.duration_ms)}
                </span>
                <span className="w-10 shrink-0 text-right font-mono tabular-nums text-text-muted">
                  {Math.round(percentValue(category.duration_ms, wallTime))}%
                </span>
                <span className="w-8 shrink-0 text-right font-mono tabular-nums text-text-muted">
                  {category.kind === 'gap' ? '--' : `×${category.sample_count}`}
                </span>
              </div>
            ))}
        </div>

        <p className="mt-2 text-xs text-text-muted" data-testid="task-timing-coverage">
          {t('timing.summary.coverage', {
            observed: formatDuration(observedMs),
            percent: `${coverage.toFixed(0)}%`,
          })}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-text-muted" data-testid="task-timing-hint">
          {t('timing.summary.hint')}
        </p>
      </section>

      <section aria-labelledby="task-timing-timeline-title" data-testid="task-timing-timeline">
        <div className="rounded-lg border border-border bg-surface p-3">
          <h3
            id="task-timing-timeline-title"
            className="border-l-2 border-primary pl-2 text-xs font-semibold uppercase tracking-wide text-text-primary"
          >
            {t('timing.timeline.title')}
          </h3>
          <p className="mb-1 mt-1 text-[11px] leading-4 text-text-muted">
            {t('timing.timeline.inclusive_note')}
          </p>
          <TimelineTrace data={data} bounds={bounds} gaps={gaps} />
        </div>
      </section>

      <section aria-labelledby="task-timing-spans-title" data-testid="task-timing-spans">
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="task-timing-spans-title"
              className="border-l-2 border-primary pl-2 text-xs font-semibold uppercase tracking-wide text-text-primary"
            >
              {t('timing.spans.title')}
            </h3>
          </div>
          <SpanTable data={data} bounds={bounds} />
        </div>
      </section>
    </div>
  )
}

function TimelineTrace({
  data,
  bounds,
  gaps,
}: {
  data: TaskTimingResponse
  bounds: TimelineBounds
  gaps: Array<{ start: number; end: number }>
}) {
  const { t } = useTranslation('tasks')
  const tracks = useMemo(() => buildTimelineTracks(data.spans, bounds), [bounds, data.spans])
  const scale = Math.max((bounds.end ?? 0) - (bounds.start ?? 0), 1)
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  if (tracks.length === 0) {
    return <p className="mt-2 text-xs text-text-muted">{t('timing.timeline.empty')}</p>
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mt-2" data-testid="task-timing-timeline-details">
        <div className="flex gap-2">
          <span className="w-20 shrink-0" />
          <div className="relative min-w-0 flex-1">
            <div className="flex h-4 items-end border-b border-border text-[10px] text-text-muted">
              {ticks.map(tick => (
                <span key={tick} className="flex-1 tabular-nums">
                  {formatDuration(scale * tick)}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-1 space-y-0.5">
          <div
            className="flex items-center gap-2"
            data-testid="task-timing-track"
            data-kind="coverage"
          >
            <span
              className="w-20 shrink-0 truncate text-xs text-text-secondary"
              title={t('timing.categories.gap.description')}
            >
              {t('timing.timeline.coverage')}
            </span>
            <div className="relative h-4 min-w-0 flex-1 overflow-hidden rounded bg-surface dark:bg-white/5">
              {gaps.map(gap => (
                <Tooltip key={`coverage-gap-${gap.start}-${gap.end}`}>
                  <TooltipTrigger asChild>
                    <span
                      className={`group absolute inset-0 cursor-default ${unobservedBackground()}`}
                      style={intervalPosition(gap.start, gap.end, bounds)}
                      data-testid="task-timing-interior-gap"
                      aria-label={t('timing.timeline.gap_meta', {
                        start: formatTimestamp(gap.start),
                        end: formatTimestamp(gap.end),
                        duration: formatDuration(gap.end - gap.start),
                      })}
                    />
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="timing-tooltip max-w-72 border-border bg-popover p-3 text-popover-foreground shadow-popover"
                  >
                    <TimingGapTooltip
                      start={formatTimestamp(gap.start)}
                      end={formatTimestamp(gap.end)}
                      duration={formatDuration(gap.end - gap.start)}
                    />
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>

          {tracks.map(track => (
            <div
              className="flex items-center gap-2"
              data-testid="task-timing-track"
              data-kind={track.category}
              key={track.category}
            >
              <span
                className="w-20 shrink-0 truncate text-xs text-text-secondary"
                title={t(`timing.categories.${track.category}.description`, {
                  defaultValue: track.category,
                })}
              >
                {t(`timing.summary.${track.category}`, { defaultValue: track.category })}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                {track.lanes.map((lane, laneIndex) => (
                  <div
                    className="relative h-4 min-w-0 overflow-hidden rounded bg-surface dark:bg-white/5"
                    key={`lane-${track.category}-${laneIndex}`}
                  >
                    {lane.map(span => {
                      const interval = spanInterval(span, bounds)
                      if (!interval) return null
                      const duration = interval.end - interval.start
                      const position = intervalPosition(interval.start, interval.end, bounds)
                      return (
                        <Tooltip key={span.id}>
                          <TooltipTrigger asChild>
                            <span
                              className={`group absolute inset-y-0.5 cursor-default rounded-sm timing-span-pulse ${categoryBackground(span.kind)}`}
                              style={{
                                ...position,
                                minWidth: duration > 0 ? '2px' : '1px',
                              }}
                              aria-label={spanTooltip(span, bounds, t)}
                              data-testid="task-timing-span-bar"
                              data-kind={span.kind}
                            />
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="timing-tooltip max-w-72 border-border bg-popover p-3 text-popover-foreground shadow-popover"
                          >
                            <TimingSpanTooltip span={span} bounds={bounds} />
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}

function TimingGapTooltip({
  start,
  end,
  duration,
}: {
  start: string
  end: string
  duration: string
}) {
  const { t } = useTranslation('tasks')
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-popover-foreground">{t('timing.summary.gap')}</p>
      <TimingTooltipRow label={t('timing.spans.duration')} value={duration} />
      <TimingTooltipRow label={t('timing.spans.start')} value={start} />
      <TimingTooltipRow label={t('timing.spans.end')} value={end} />
    </div>
  )
}

function TimingSpanTooltip({ span, bounds }: { span: TimingSpan; bounds: TimelineBounds }) {
  const { t } = useTranslation('tasks')
  const interval = spanInterval(span, bounds)
  return (
    <div className="space-y-1.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-popover-foreground">
          {span.actor_label || span.kind}
        </p>
        <p className="mt-0.5 text-[11px] text-popover-foreground/70">
          {t(`timing.summary.${timelineCategory(span.kind)}`, { defaultValue: span.kind })}
        </p>
      </div>
      <TimingTooltipRow
        label={t('timing.spans.duration')}
        value={isOpenSpan(span) ? t('timing.spans.running') : formatDuration(spanDuration(span))}
      />
      <TimingTooltipRow label={t('timing.spans.subtask')} value={span.subtask_id ?? '--'} />
      {interval ? (
        <TimingTooltipRow
          label={t('timing.spans.interval')}
          value={`${formatTimestamp(interval.start)} → ${formatTimestamp(interval.end)}`}
        />
      ) : null}
      <TimingTooltipRow label="Span ID" value={span.span_id} />
    </div>
  )
}

function TimingTooltipRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-[11px] text-popover-foreground/60">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-[11px] text-popover-foreground">
        {value}
      </span>
    </div>
  )
}

function SpanTable({ data, bounds }: { data: TaskTimingResponse; bounds: TimelineBounds }) {
  const { t } = useTranslation('tasks')
  const [sortBy, setSortBy] = useState<'start' | 'duration'>('start')
  const [showAll, setShowAll] = useState(false)

  const sortedSpans = useMemo(() => {
    const spans = [...data.spans]
    if (sortBy === 'duration') {
      spans.sort((left, right) => spanDuration(right) - spanDuration(left))
    } else {
      spans.sort((left, right) => {
        const leftStart = left.start_at_ms ?? Number.POSITIVE_INFINITY
        const rightStart = right.start_at_ms ?? Number.POSITIVE_INFINITY
        return leftStart - rightStart || left.id - right.id
      })
    }
    return spans
  }, [data.spans, sortBy])

  const visibleSpans = showAll ? sortedSpans : sortedSpans.slice(0, DEFAULT_VISIBLE_SPANS)
  const hasMoreSpans = sortedSpans.length > DEFAULT_VISIBLE_SPANS

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          onClick={() => setSortBy(sortBy === 'start' ? 'duration' : 'start')}
          data-testid="task-timing-sort-spans"
        >
          {sortBy === 'start'
            ? t('timing.spans.sort_by_duration')
            : t('timing.spans.sort_by_start')}
        </Button>
        {hasMoreSpans ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => setShowAll(!showAll)}
            data-testid="task-timing-toggle-spans"
          >
            {showAll
              ? t('timing.spans.show_less')
              : t('timing.spans.show_all', { count: sortedSpans.length })}
          </Button>
        ) : null}
      </div>

      <div className="overflow-x-auto" data-testid="task-timing-span-table">
        <table className="w-full min-w-[560px] border-collapse text-xs">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="border-b border-border px-2 py-1.5 font-medium">
                {t('timing.spans.subtask')}
              </th>
              <th className="border-b border-border px-2 py-1.5 font-medium">
                {t('timing.spans.kind')}
              </th>
              <th className="border-b border-border px-2 py-1.5 font-medium">
                {t('timing.spans.label')}
              </th>
              <th className="border-b border-border px-2 py-1.5 font-medium">
                {t('timing.spans.interval')}
              </th>
              <th className="border-b border-border px-2 py-1.5 text-right font-medium">
                {t('timing.spans.duration')}
              </th>
              <th className="border-b border-border px-2 py-1.5 font-medium">
                {t('timing.spans.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleSpans.map(span => {
              const interval = spanInterval(span, bounds)
              const offsetStart = interval && bounds.start ? interval.start - bounds.start : 0
              const offsetEnd = interval && bounds.start ? interval.end - bounds.start : 0
              return (
                <tr
                  key={span.id}
                  className="hover:bg-surface-hover/50"
                  data-testid="task-timing-span-row"
                  title={spanTooltip(span, bounds, t)}
                >
                  <td className="border-b border-border px-2 py-1.5 tabular-nums">
                    {span.subtask_id}
                  </td>
                  <td className="border-b border-border px-2 py-1.5">
                    {t(`timing.summary.${timelineCategory(span.kind)}`, {
                      defaultValue: span.kind,
                    })}
                  </td>
                  <td className="max-w-[180px] truncate border-b border-border px-2 py-1.5">
                    {span.actor_label || span.kind}
                  </td>
                  <td className="whitespace-nowrap border-b border-border px-2 py-1.5 tabular-nums text-text-secondary">
                    {interval
                      ? `${formatDuration(offsetStart)} → ${formatDuration(offsetEnd)}`
                      : '--'}
                  </td>
                  <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
                    {isOpenSpan(span)
                      ? t('timing.spans.running')
                      : formatDuration(spanDuration(span))}
                  </td>
                  <td className="border-b border-border px-2 py-1.5">
                    <Badge variant={statusVariant(span.status)} size="sm">
                      {t(`timing.status.${span.status}`, { defaultValue: span.status })}
                    </Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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
