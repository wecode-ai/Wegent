import { collaborationMessages, threadStatuses } from '@wegent/collaboration'

export function threadLifecycleLabel(
  metadata: Record<string, unknown>,
  locale: 'zh-CN' | 'en'
): { key: string; status?: string } {
  if (metadata.event_type === 'created') return { key: 'createdEvent' }
  if (metadata.event_type === 'reopened') return { key: 'reopenedEvent' }
  const status = threadStatuses(collaborationMessages[locale]).find(
    candidate => candidate.id === metadata.thread_status
  )
  if (status?.id === 'completed') return { key: 'completedEvent' }
  return status ? { key: 'changedEventTo', status: status.name } : { key: 'changedEvent' }
}
