import type { ToolBlock } from './types'

type Translate = (key: string, options?: Record<string, string | number>) => string

export function runtimeRetryStatus(block: ToolBlock, t: Translate): string {
  const input = block.toolInput
  const key =
    input?.retry_reason === 'overload'
      ? 'server_overloaded_retry'
      : input?.retry_reason === 'rate_limit'
        ? 'rate_limit_wait'
        : input?.retry_reason === 'connection'
          ? 'reconnecting'
          : 'retrying'
  const status = t(`tool_activity.${key}`)
  const progress = runtimeRetryProgress(block)
  return progress ? t('tool_activity.retry_progress', { status, ...progress }) : status
}

export function runtimeRetryProgress(
  block: ToolBlock
): { attempt: number; total: number } | undefined {
  const input = block.toolInput
  // Native Codex embeds progress in its reconnect message; local recovery supplies fields.
  const progress =
    typeof input?.message === 'string'
      ? input.message.match(/^Reconnecting\.{0,3}\s*(\d+)\s*\/\s*(\d+)\s*$/i)
      : undefined
  const attempt = input?.retry_attempt ?? (progress ? Number(progress[1]) : undefined)
  const total = input?.retry_max_attempts ?? (progress ? Number(progress[2]) : undefined)
  return typeof attempt === 'number' &&
    Number.isSafeInteger(attempt) &&
    attempt > 0 &&
    typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    total >= attempt
    ? { attempt, total }
    : undefined
}
