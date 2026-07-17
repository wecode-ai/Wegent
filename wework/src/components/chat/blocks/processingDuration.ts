import type { ProcessingBlock } from '@/types/workbench'

export function getDurationText(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): string {
  const durationMs = getProcessingDurationMs(blocks, turnStartedAt, now, completedAt, isRunning)
  if (durationMs < 1000) return ''
  return `已处理 ${formatDuration(durationMs)}`
}

export function getWholeSecondsDurationText(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): string {
  const durationMs = getProcessingDurationMs(blocks, turnStartedAt, now, completedAt, isRunning)
  return `${Math.floor(durationMs / 1000)} 秒`
}

function getProcessingDurationMs(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean
): number {
  const lastBlock = blocks[blocks.length - 1]
  const last = lastBlock?.completedAt ?? lastBlock?.createdAt ?? turnStartedAt
  const endTime = isRunning ? now : (completedAt ?? last)
  return Math.max(isRunning ? 1000 : 0, endTime - turnStartedAt)
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds} 秒`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainingMinutes} 分钟`
}
