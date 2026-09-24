import type { WorkbenchMessage } from '@/types/workbench'
import type { WorkspaceProjectManagerRun } from '@wegent/collaboration'

export function projectManagerConversationMessages(
  messages: WorkbenchMessage[],
  run: WorkspaceProjectManagerRun | undefined
): WorkbenchMessage[] {
  if (run?.status !== 'cancelled') return messages

  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      assistantIndex = index
      break
    }
  }

  if (assistantIndex >= 0) {
    return messages.map((message, index) =>
      index === assistantIndex
        ? {
            ...message,
            status: 'done',
            runtimeStatus: 'cancelled',
            stoppedNotice: true,
            completedAt: run.completedAt ?? message.completedAt,
          }
        : message
    )
  }

  return [
    ...messages,
    {
      id: `project-ai-assistant-${run.id}`,
      role: 'assistant',
      content: '',
      status: 'done',
      runtimeStatus: 'cancelled',
      stoppedNotice: true,
      createdAt: run.createdAt ?? '',
      completedAt: run.completedAt,
    },
  ]
}
