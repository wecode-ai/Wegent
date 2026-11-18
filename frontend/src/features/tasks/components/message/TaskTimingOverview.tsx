'use client'

import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

type Timing = Record<string, number>

interface Stage {
  id: string
  label: string
  durationMs: number
  share: number
}

export function TaskTimingOverview({ timing }: { timing?: Timing }) {
  const [expanded, setExpanded] = useState(false)
  const stages = useMemo(() => buildStages(timing), [timing])
  if (!timing || stages.length === 0) return null

  return (
    <div className="mb-2 w-full text-xs text-text-muted" data-testid="task-timing-overview">
      <button
        type="button"
        data-testid="task-timing-overview-toggle"
        aria-expanded={expanded}
        className="inline-flex min-h-8 items-center gap-1 hover:text-text-secondary"
        onClick={() => setExpanded(value => !value)}
      >
        <span className="tabular-nums">{buildSummary(stages)}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
      </button>
      {expanded ? <TaskTimingWaterfall stages={stages} /> : null}
    </div>
  )
}

function buildStages(timing?: Timing): Stage[] {
  if (!timing) return []
  const stage = (id: string, label: string, durationMs: number | undefined): Stage | null =>
    durationMs !== undefined && durationMs >= 0 ? { id, label, durationMs, share: 0 } : null

  const observed = [
    stage('queue', '排队等待', timing.queueDurationMs),
    stage('create', '容器创建', timing.createDurationMs),
    stage('ready', '等待就绪', timing.waitReadyDurationMs),
    stage('dispatch', '任务派发', timing.dispatchDurationMs),
    stage('agent', 'Agent 执行', timing.agentDurationMs),
  ].filter((item): item is Stage => item !== null)
  const total = Math.max(totalDuration(observed), 1)
  return observed.map(stage => ({ ...stage, share: stage.durationMs / total }))
}

function totalDuration(stages: Stage[]): number {
  return stages.reduce((sum, stage) => sum + stage.durationMs, 0)
}

function buildSummary(stages: Stage[]): string {
  const names = ['queue', 'ready', 'agent']
  const parts = stages
    .filter(stage => names.includes(stage.id))
    .map(stage => `${stage.label} ${formatDuration(stage.durationMs)}`)
  return parts.length > 0 ? `耗时分布 · ${parts.join(' · ')}` : '耗时分布'
}

function TaskTimingWaterfall({ stages }: { stages: Stage[] }) {
  return (
    <div className="mt-2 space-y-1.5" data-testid="task-timing-waterfall">
      {stages.map(stage => {
        const width = Math.max(stage.share * 100, 1)
        return (
          <div key={stage.id} className="flex min-w-0 items-center gap-2">
            <span className="w-20 shrink-0 truncate">{stage.label}</span>
            <span className="h-1.5 min-w-1 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary/70"
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums">
              {formatDuration(stage.durationMs)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(Math.max(durationMs, 0) / 1000)
  const units: [number, string][] = [
    [Math.floor(seconds / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'm'],
    [seconds % 60, 's'],
  ]
  return (
    units
      .filter(([value]) => value > 0)
      .map(([value, unit]) => `${value}${unit}`)
      .join(' ') || '0s'
  )
}
