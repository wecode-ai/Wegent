import { useState } from 'react'
import { useClock } from '../../clock'
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
  const now = useClock(isRunning)
  const [clock, setClock] = useState(() => ({
    wasRunning: isRunning,
    now: Date.now(),
    completedAt: null as number | null,
  }))

  if (clock.wasRunning !== isRunning) {
    setClock(() => {
      const now = Date.now()
      return {
        wasRunning: isRunning,
        now,
        completedAt: isRunning ? null : now,
      }
    })
  }

  if (!timing) return ''
  return getDurationText(
    timing.blocks,
    timing.startedAt,
    isRunning ? now : clock.now,
    clock.completedAt,
    isRunning
  ).replace(/^已处理\s*/, '')
}
