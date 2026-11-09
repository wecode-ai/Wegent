import { formatNotificationTime } from './notificationTime'

export function InteractionTime({ timestamp, testId }: { timestamp: number; testId: string }) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime()) || timestamp <= 0) return null
  return (
    <time
      data-testid={testId}
      className="block text-xs text-text-secondary"
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
    >
      {formatNotificationTime(timestamp)}
    </time>
  )
}
