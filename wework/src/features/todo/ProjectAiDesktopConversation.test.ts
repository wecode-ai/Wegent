import { describe, expect, it } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import type { WorkspaceProjectManagerRun } from '@wegent/collaboration'
import { projectManagerConversationMessages } from './projectAiConversationMessages'

const cancelledRun = {
  id: 'run-1',
  status: 'cancelled',
  createdAt: '2026-09-24T10:00:00.000Z',
  completedAt: '2026-09-24T10:00:05.000Z',
} as WorkspaceProjectManagerRun

describe('projectManagerConversationMessages', () => {
  it('settles the streamed assistant message when the manager run is cancelled', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Stop this project AI session',
        status: 'done',
        createdAt: cancelledRun.createdAt ?? '',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        runtimeStatus: 'streaming',
        createdAt: cancelledRun.createdAt ?? '',
      },
    ]

    expect(projectManagerConversationMessages(messages, cancelledRun)).toEqual([
      messages[0],
      {
        ...messages[1],
        status: 'done',
        runtimeStatus: 'cancelled',
        stoppedNotice: true,
        completedAt: cancelledRun.completedAt,
      },
    ])
  })

  it('adds the shared stopped assistant state when the transcript has only the user message', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Stop this project AI session',
        status: 'done',
        createdAt: cancelledRun.createdAt ?? '',
      },
    ]

    expect(projectManagerConversationMessages(messages, cancelledRun)).toEqual([
      messages[0],
      {
        id: 'project-ai-assistant-run-1',
        role: 'assistant',
        content: '',
        status: 'done',
        runtimeStatus: 'cancelled',
        stoppedNotice: true,
        createdAt: cancelledRun.createdAt,
        completedAt: cancelledRun.completedAt,
      },
    ])
  })
})
