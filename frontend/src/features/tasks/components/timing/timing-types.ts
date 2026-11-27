import type { TaskTimingResponse } from '@/apis/tasks'

export type TimingSpan = TaskTimingResponse['spans'][number]
export type TimingCategory = TaskTimingResponse['triage'][number]
export type TimelineBounds = {
  start?: number
  end?: number
}
