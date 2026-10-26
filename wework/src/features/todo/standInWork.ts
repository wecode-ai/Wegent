import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'

export function standInWorkRole(item: RuntimeTaskReminderItem): string | null {
  const origin = item.task.runtimeHandle?.origin as Record<string, unknown> | undefined
  if (origin?.initiatedBy !== 'stand_in') return null
  return typeof origin.standInId === 'string' ? origin.standInId : 'default'
}
