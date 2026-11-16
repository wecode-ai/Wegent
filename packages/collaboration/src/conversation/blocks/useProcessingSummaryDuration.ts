import { useEffect, useState } from 'react'
import { getDurationText } from './processingDuration'
import type { ProcessingBlock } from './types'

export interface ProcessingSummaryTiming {
  blocks: ProcessingBlock[]
  startedAt: number
  isRunning: boolean
}

// The header owns its clock; hidden durations must never tick the tool list.
export function useProcessingSummaryDuration(timing: ProcessingSummaryTiming | undefined): string {
  const isRunning = timing?.isRunning ?? false
  const [clock, setClock] = useState(() => ({
    wasRunning: isRunning,
    now: Date.now(),
    completedAt: null as number | null,
  }))

  if (clock.wasRunning !== isRunning) {
    setClock(() => {
      const now = Date.now()
      return { wasRunning: isRunning, now, completedAt: isRunning ? null : now }
    })
  }

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => {
      setClock(current => ({ ...current, now: Date.now() }))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  if (!timing) return ''
  return getDurationText(
    timing.blocks,
    timing.startedAt,
    clock.now,
    clock.completedAt,
    isRunning
  ).replace(/^已处理\s*/, '')
}
