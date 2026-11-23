import type { TaskTimingResponse } from '@/apis/tasks'
import type { TimingCategory, TimingSpan, TimelineBounds } from './timing-types'

import { useMemo } from 'react'

const TIMELINE_CATEGORY_ORDER = ['agent', 'subagent', 'tool', 'waiting_user', 'runtime', 'other']

export function buildTimelineTracks(
  spans: TimingSpan[],
  bounds: TimelineBounds
): Array<{
  category: string
  lanes: TimingSpan[][]
}> {
  const grouped = new Map<string, TimingSpan[]>()
  for (const span of spans) {
    const category = timelineCategory(span.kind)
    const trackSpans = grouped.get(category) ?? []
    trackSpans.push(span)
    grouped.set(category, trackSpans)
  }

  const explicitOrder = TIMELINE_CATEGORY_ORDER.filter(category => grouped.has(category))
  const otherCategories = [...grouped.keys()]
    .filter(category => !TIMELINE_CATEGORY_ORDER.includes(category))
    .sort()

  return [...explicitOrder, ...otherCategories].map(category => {
    const categorySpans = (grouped.get(category) ?? []).sort((left, right) => {
      const leftStart = left.start_at_ms ?? Number.POSITIVE_INFINITY
      const rightStart = right.start_at_ms ?? Number.POSITIVE_INFINITY
      return leftStart - rightStart || left.id - right.id
    })
    return {
      category,
      lanes: packTimelineLanes(categorySpans, bounds),
    }
  })
}

export function packTimelineLanes(spans: TimingSpan[], bounds: TimelineBounds): TimingSpan[][] {
  const lanes: Array<{ end: number; spans: TimingSpan[] }> = []
  for (const span of spans) {
    const interval = spanInterval(span, bounds)
    if (!interval) continue
    const lane = lanes.find(candidate => interval.start >= candidate.end)
    if (lane) {
      lane.spans.push(span)
      lane.end = Math.max(lane.end, interval.end)
    } else {
      lanes.push({ end: interval.end, spans: [span] })
    }
  }
  return lanes.map(lane => lane.spans)
}

export function timelineCategory(kind: string): string {
  switch (kind) {
    case 'agent':
    case 'subagent':
    case 'tool':
    case 'waiting_user':
      return kind
    case 'queue':
    case 'provision':
      return 'runtime'
    default:
      return 'other'
  }
}

export function categoryBackground(kind: string): string {
  switch (timelineCategory(kind)) {
    case 'agent':
      return 'h-full bg-blue-500 dark:bg-blue-400'
    case 'subagent':
      return 'h-full bg-violet-500 dark:bg-violet-400'
    case 'tool':
      return 'h-full bg-emerald-500 dark:bg-emerald-400'
    case 'waiting_user':
      return 'h-full bg-amber-400 dark:bg-amber-300'
    case 'runtime':
      return 'h-full bg-cyan-500 dark:bg-cyan-400'
    default:
      return 'h-full bg-rose-500 dark:bg-rose-400'
  }
}

export function unobservedBackground(): string {
  return 'bg-zinc-300 dark:bg-zinc-600'
}

export function categoryDot(kind: string): string {
  if (kind === 'gap') {
    return unobservedBackground()
  }
  return categoryBackground(kind).replace('h-full ', '')
}

export function statusVariant(status: string): 'success' | 'error' | 'secondary' {
  if (status === 'completed' || status === 'COMPLETED') return 'success'
  if (status === 'failed' || status === 'FAILED' || status === 'CANCELLED') return 'error'
  return 'secondary'
}

export function percentValue(durationMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0
  return Math.max(Math.min((durationMs / totalMs) * 100, 100), 0)
}

export function spanDuration(span: TimingSpan): number {
  const start = span.start_at_ms
  if (start === null || start === undefined) return span.duration_ms ?? 0
  if (span.duration_ms !== null && span.duration_ms !== undefined) return span.duration_ms
  if (span.end_at_ms !== null && span.end_at_ms !== undefined) {
    return Math.max(span.end_at_ms - start, 0)
  }
  return 0
}

export function isOpenSpan(span: TimingSpan): boolean {
  return span.end_at_ms === null && (span.duration_ms === null || span.duration_ms === undefined)
}

export function spanTooltip(
  span: TimingSpan,
  bounds: TimelineBounds,
  t: (key: string, options?: Record<string, string | number>) => string
): string {
  const interval = spanInterval(span, bounds)
  const subtaskId = span.subtask_id ?? '--'
  return [
    span.actor_label || span.kind,
    t(`timing.summary.${timelineCategory(span.kind)}`, { defaultValue: span.kind }),
    isOpenSpan(span)
      ? t('timing.timeline.open_span_meta', { kind: span.kind, subtask: subtaskId })
      : t('timing.timeline.span_meta', {
          kind: span.kind,
          subtask: subtaskId,
          duration: formatDuration(spanDuration(span)),
        }),
    interval ? `${formatTimestamp(interval.start)} → ${formatTimestamp(interval.end)}` : undefined,
    `span_id=${span.span_id}`,
    `clock=${span.clock}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function buildMarkdownReport(
  data: TaskTimingResponse,
  bounds: TimelineBounds,
  gaps: Array<{ start: number; end: number }>
): string {
  const wallTime = data.wall_time_ms ?? categoryTotal(data.triage)
  const observedMs = data.observed_ms ?? Math.max(wallTime - (data.unobserved_ms ?? 0), 0)
  const lines = [
    '# Wegent Timing Diagnostic Report',
    '',
    `- Task ID: ${data.task_id}`,
    `- Status: ${data.task_status}`,
    `- Wall time: ${formatDuration(wallTime)}`,
    `- Sampled: ${formatDuration(observedMs)} (${percentValue(observedMs, wallTime).toFixed(1)}%)`,
    `- Window: ${formatIsoTimestamp(data.session_start_at_ms)} → ${formatIsoTimestamp(
      data.session_end_at_ms
    )}`,
    '',
    '## Attribution',
    '',
    '| Category | Duration | Share | Samples | Sampled |',
    '| --- | ---: | ---: | ---: | --- |',
  ]

  for (const category of data.triage) {
    lines.push(
      `| ${category.kind} | ${formatDuration(category.duration_ms)} | ${percentValue(
        category.duration_ms,
        wallTime
      ).toFixed(1)}% | ${category.sample_count} | ${category.observed ? 'yes' : 'no'} |`
    )
  }

  if (gaps.length > 0) {
    lines.push(
      '',
      '## Unsampled intervals',
      '',
      '| Start | End | Duration |',
      '| --- | --- | ---: |'
    )
    for (const gap of gaps) {
      lines.push(
        `| ${formatIsoTimestamp(gap.start)} | ${formatIsoTimestamp(gap.end)} | ${formatDuration(
          gap.end - gap.start
        )} |`
      )
    }
  }

  lines.push(
    '',
    '## Execution intervals',
    '',
    '| Subtask | Kind | Label | Relative | Start | End | Duration | Status | Span ID | Clock | Source |',
    '| ---: | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |'
  )
  const spans = [...data.spans].sort((left, right) => {
    const leftStart = left.start_at_ms ?? Number.POSITIVE_INFINITY
    const rightStart = right.start_at_ms ?? Number.POSITIVE_INFINITY
    return leftStart - rightStart || left.id - right.id
  })
  for (const span of spans) {
    const interval = spanInterval(span, bounds)
    const offsetStart = interval && bounds.start ? interval.start - bounds.start : undefined
    const offsetEnd = interval && bounds.start ? interval.end - bounds.start : undefined
    lines.push(
      `| ${span.subtask_id} | ${span.kind} | ${escapeMarkdownTableCell(
        span.actor_label || span.kind
      )} | ${formatDuration(offsetStart)} → ${formatDuration(offsetEnd)} | ${formatIsoTimestamp(
        interval?.start
      )} | ${formatIsoTimestamp(interval?.end)} | ${formatDuration(
        spanDuration(span)
      )} | ${span.status} | ${span.span_id} | ${span.clock} | ${span.source} |`
    )
  }
  return lines.join('\n')
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function categoryTotal(categories: TimingCategory[]): number {
  return categories.reduce((total, category) => total + category.duration_ms, 0)
}

export function useTimelineBounds(data: TaskTimingResponse): TimelineBounds {
  return useMemo(() => {
    return timelineBounds(data)
  }, [data])
}

export function timelineBounds(data: TaskTimingResponse): TimelineBounds {
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
    return { start, end: start }
  }
  return { start, end }
}

export function unobservedIntervals(
  data: TaskTimingResponse,
  bounds: TimelineBounds
): Array<{ start: number; end: number }> {
  if (bounds.start === undefined || bounds.end === undefined) return []
  const intervals = data.spans
    .map(span => {
      const interval = spanInterval(span, bounds)
      return interval ? ([interval.start, interval.end] as const) : undefined
    })
    .filter((interval): interval is readonly [number, number] => interval !== undefined)
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

export function intervalPosition(
  start: number,
  end: number,
  bounds: TimelineBounds
): { left: string; width: string } {
  if (bounds.start === undefined || bounds.end === undefined) {
    return { left: '0%', width: '0%' }
  }
  const scale = Math.max(bounds.end - bounds.start, 1)
  const left = Math.max(Math.min(start - bounds.start, scale), 0)
  const right = Math.max(Math.min(end - bounds.start, scale), 0)
  return {
    left: `${(left / scale) * 100}%`,
    width: `${(Math.max(right - left, 0) / scale) * 100}%`,
  }
}

export function spanInterval(
  span: TimingSpan,
  bounds: TimelineBounds
): { start: number; end: number } | undefined {
  if (span.start_at_ms === null || span.start_at_ms === undefined) return undefined
  const start = span.start_at_ms
  const end =
    span.end_at_ms ??
    (span.duration_ms === null || span.duration_ms === undefined
      ? (bounds.end ?? start)
      : start + span.duration_ms)
  if (end < start) return { start, end: start }
  return { start, end }
}

function validTimestamp(timestampMs?: number | null): number | undefined {
  return timestampMs === null || timestampMs === undefined ? undefined : timestampMs
}

export function formatDuration(durationMs?: number | null): string {
  if (durationMs === null || durationMs === undefined) return '--'
  if (durationMs < 1000) return `${Math.max(Math.round(durationMs), 0)}ms`
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`
  }
  const hours = Math.floor(seconds / 3600)
  const remainingMinutes = Math.floor((seconds % 3600) / 60)
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

export function formatTimestamp(timestampMs?: number | null): string {
  if (timestampMs === null || timestampMs === undefined) return '--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs))
}

export function formatIsoTimestamp(timestampMs?: number | null): string {
  if (timestampMs === null || timestampMs === undefined) return '--'
  return new Date(timestampMs).toISOString()
}
