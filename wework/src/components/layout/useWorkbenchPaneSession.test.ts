import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  reconcileRuntimeConversationMessages,
  transcriptSettlesLatestSeededTurn,
} from './useWorkbenchPaneSession'

function message(overrides: Partial<WorkbenchMessage>): WorkbenchMessage {
  return {
    id: 'message',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  }
}

describe('reconcileRuntimeConversationMessages', () => {
  test('uses a settled server transcript instead of stale streaming cache state', () => {
    const transcript = [message({ id: 'server', content: 'Complete response' })]
    const cached = [
      message({
        id: 'cached',
        content: 'Complete response with stale streaming metadata',
        status: 'streaming',
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, false)).toBe(transcript)
  })

  test('keeps richer live state while the server still reports the task running', () => {
    const transcript = [message({ id: 'server', content: 'Partial', status: 'streaming' })]
    const cached = [
      message({
        id: 'cached',
        content: 'Partial response from the live stream',
        status: 'streaming',
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, true)).toBe(cached)
  })

  test('preserves completed live tool blocks missing from a settled transcript', () => {
    const transcript = [
      message({
        id: 'server',
        turnId: 'turn-1',
        subtaskId: 'turn-1',
        content: 'Complete response',
        blocks: [
          {
            id: 'file-changes-1',
            type: 'file_changes',
            status: 'done',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-1',
              device_id: 'device-1',
              workspace_path: '/workspace',
              file_count: 1,
              additions: 1,
              deletions: 0,
              files: [],
              reverted_at: null,
            },
          },
        ],
      }),
    ]
    const cached = [
      message({
        id: 'cached',
        turnId: 'turn-1',
        subtaskId: 'runtime-subtask-1',
        content: 'Complete response',
        blocks: [
          {
            id: 'view-image-1',
            type: 'tool',
            toolName: 'view_image',
            toolInput: { path: '/workspace/image.png' },
            status: 'done',
          },
          {
            id: 'command-1',
            type: 'tool',
            toolName: 'exec_command',
            toolInput: { cmd: 'pwd' },
            status: 'done',
          },
          {
            id: 'file-changes-1',
            type: 'file_changes',
            status: 'streaming',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-1',
              device_id: 'device-1',
              workspace_path: '/workspace',
              file_count: 1,
              additions: 1,
              deletions: 0,
              files: [],
              reverted_at: null,
            },
          },
        ],
      }),
    ]

    const reconciled = reconcileRuntimeConversationMessages(transcript, cached, false)

    expect(reconciled[0].status).toBe('done')
    expect(reconciled[0].subtaskId).toBe('turn-1')
    expect(reconciled[0].blocks?.map(block => block.id)).toEqual([
      'view-image-1',
      'command-1',
      'file-changes-1',
    ])
    expect(reconciled[0].blocks?.[2].status).toBe('done')
  })

  test('does not preserve unfinished live blocks after the transcript settles', () => {
    const transcript = [
      message({
        id: 'server',
        turnId: 'turn-1',
        content: 'Complete response',
      }),
    ]
    const cached = [
      message({
        id: 'cached',
        turnId: 'turn-1',
        status: 'streaming',
        blocks: [
          {
            id: 'command-1',
            type: 'tool',
            toolName: 'exec_command',
            toolInput: { cmd: 'sleep 10' },
            status: 'streaming',
          },
        ],
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, false)).toBe(transcript)
  })
})

describe('transcriptSettlesLatestSeededTurn', () => {
  test('does not settle a live turn from an older turn with duplicate user content', () => {
    const transcript = [
      message({ id: 'older-user', role: 'user', content: 'Continue' }),
      message({ id: 'older-assistant', content: 'Older completed response' }),
    ]
    const seeded = [message({ id: 'live-user', role: 'user', content: 'Continue' })]

    expect(transcriptSettlesLatestSeededTurn(transcript, seeded)).toBe(false)
  })

  test('settles the seeded turn only after its client message id appears', () => {
    const seeded = [message({ id: 'live-user', role: 'user', content: 'Continue' })]
    const transcript = [
      message({ id: 'live-user', role: 'user', content: 'Continue' }),
      message({ id: 'live-assistant', content: 'Current completed response' }),
    ]

    expect(transcriptSettlesLatestSeededTurn(transcript, seeded)).toBe(true)
  })
})
