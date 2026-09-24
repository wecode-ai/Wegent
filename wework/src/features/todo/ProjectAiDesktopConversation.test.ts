import { describe, expect, it } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  projectManagerConversationMessages,
  projectManagerFallbackMessages,
  type WorkspaceProjectManagerRun,
} from '@wegent/collaboration'

const cancelledRun = {
  id: 'run-1',
  status: 'cancelled',
  createdAt: '2026-09-24T10:00:00.000Z',
  completedAt: '2026-09-24T10:00:05.000Z',
} as WorkspaceProjectManagerRun

describe('projectManagerConversationMessages', () => {
  it('leaves successful Runtime transcript messages unchanged', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-follow-up',
        role: 'assistant',
        content: 'Second response',
        status: 'streaming',
        createdAt: cancelledRun.createdAt ?? '',
      },
    ]
    const completedInitialRun = {
      ...cancelledRun,
      status: 'succeeded',
      response: 'First response',
    } as WorkspaceProjectManagerRun

    expect(projectManagerConversationMessages(messages, completedInitialRun)).toBe(messages)
  })

  it('uses the shared thinking state while waiting for the executor', () => {
    const messages = projectManagerFallbackMessages(
      [
        {
          id: 'run-waiting',
          status: 'queued',
          instruction: 'Create an Issue',
          createdAt: '2026-09-24T10:00:00.000Z',
        } as WorkspaceProjectManagerRun,
      ],
      'zh-CN'
    )

    expect(messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: '',
        status: 'streaming',
        streamingThinkingContent: '等待执行器启动…',
      })
    )
  })

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

  it('settles a stale streaming transcript with the failed manager run', () => {
    const failedRun = {
      ...cancelledRun,
      status: 'failed',
      error: 'Model configuration failed',
    } as WorkspaceProjectManagerRun
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        streamingThinkingContent: 'Starting runtime',
        createdAt: failedRun.createdAt ?? '',
      },
    ]

    expect(projectManagerConversationMessages(messages, failedRun)).toEqual([
      {
        ...messages[0],
        content: 'Model configuration failed',
        status: 'failed',
        runtimeStatus: 'failed',
        stoppedNotice: false,
        streamingThinkingContent: undefined,
        completedAt: failedRun.completedAt,
      },
    ])
  })
})
