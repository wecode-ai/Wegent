import { describe, expect, test, vi } from 'vitest'
import {
  appendRuntimeConversationGuidance,
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from './runtimeConversationTurns'
import type { ProcessingBlock, RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'

function userMessage(id: string, content: string): WorkbenchMessage {
  return {
    id,
    role: 'user',
    content,
    status: 'done',
    createdAt: '2026-07-30T00:00:00.000Z',
  }
}

function requestBlock(id: string, turnId: string): ProcessingBlock {
  return {
    id,
    subtaskId: turnId,
    type: 'tool',
    toolName: 'request_user_input',
    status: 'streaming',
    createdAt: 1,
    renderPayload: {
      kind: 'request_user_input',
      questions: [{ id: 'direction', question: 'Which direction?' }],
    },
  }
}

describe('runtimeConversationTurns', () => {
  test('binds only the exact optimistic user to the real Codex turn id', () => {
    let turns = reduceRuntimeConversationTurns([], {
      type: 'user_added',
      message: userMessage('client-user-1', 'First'),
    })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'user_added',
      message: userMessage('client-user-2', 'Second'),
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_started',
      subtaskId: 'turn-2',
      clientUserMessageId: 'client-user-2',
    })

    expect(turns.map(turn => [turn.id, turn.clientUserMessageId])).toEqual([
      [null, 'client-user-1'],
      ['turn-2', 'client-user-2'],
    ])
    expect(turns[1].items[0]).toMatchObject({
      id: 'client-user-2',
      message: { subtaskId: 'turn-2', turnId: 'turn-2' },
    })
  })

  test('binds Codex turn started to the latest unbound optimistic turn', () => {
    let turns = reduceRuntimeConversationTurns([], {
      type: 'user_added',
      message: userMessage('client-user-1', 'First'),
    })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'user_added',
      message: userMessage('client-user-2', 'Second'),
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_started',
      subtaskId: 'turn-2',
    })

    expect(turns.map(turn => [turn.id, turn.clientUserMessageId])).toEqual([
      [null, 'client-user-1'],
      ['turn-2', 'client-user-2'],
    ])
  })

  test('corrects a provisional turn id by exact client user message id', () => {
    let turns = reduceRuntimeConversationTurns([], {
      type: 'user_added',
      message: userMessage('client-user-1', 'Prompt'),
    })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_started',
      subtaskId: 'turn-from-start-response',
      clientUserMessageId: 'client-user-1',
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_started',
      subtaskId: 'turn-from-started-notification',
      clientUserMessageId: 'client-user-1',
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      id: 'turn-from-started-notification',
      clientUserMessageId: 'client-user-1',
      status: 'streaming',
    })
    expect(turns[0].items[0]).toMatchObject({
      id: 'client-user-1',
      message: {
        subtaskId: 'turn-from-started-notification',
        turnId: 'turn-from-started-notification',
      },
    })
  })

  test('does not synthesize a Codex turn from a terminal event', () => {
    const turns = reduceRuntimeConversationTurns(
      [
        {
          id: null,
          clientUserMessageId: 'client-user-1',
          items: [
            {
              id: 'client-user-1',
              type: 'user_message',
              message: userMessage('client-user-1', 'Prompt'),
            },
          ],
          status: 'pending',
        },
      ],
      {
        type: 'assistant_done',
        subtaskId: 'turn-1',
        blocks: [],
      }
    )

    expect(turns).toEqual([
      expect.objectContaining({
        id: null,
        clientUserMessageId: 'client-user-1',
        status: 'pending',
      }),
    ])
  })

  test('promotes authoritative terminal content after unphased process blocks', () => {
    const turns = reduceRuntimeConversationTurns(
      [
        {
          id: 'turn-1',
          items: [
            {
              id: 'process-before-tool',
              type: 'block',
              block: {
                id: 'process-before-tool',
                subtaskId: 'turn-1',
                type: 'text',
                content: 'Inspecting the failure.',
                status: 'done',
                createdAt: Date.parse('2026-08-03T00:00:00.000Z'),
              },
            },
            {
              id: 'tool-1',
              type: 'block',
              block: requestBlock('tool-1', 'turn-1'),
            },
            {
              id: 'process-after-tool',
              type: 'block',
              block: {
                id: 'process-after-tool',
                subtaskId: 'turn-1',
                type: 'text',
                content: 'Found the mismatch.',
                status: 'done',
                createdAt: Date.parse('2026-08-03T00:00:01.000Z'),
              },
            },
          ],
          status: 'streaming',
        },
      ],
      {
        type: 'assistant_done',
        subtaskId: 'turn-1',
        content: 'The final answer.',
      }
    )

    expect(turns[0].items.at(-1)).toMatchObject({
      id: 'runtime-final:turn-1',
      type: 'assistant_text',
      content: 'The final answer.',
    })
    expect(projectRuntimeConversationTurns(turns)[0]).toMatchObject({
      content: 'The final answer.',
      status: 'done',
      blocks: [
        expect.objectContaining({ id: 'process-before-tool' }),
        expect.objectContaining({ id: 'tool-1' }),
        expect.objectContaining({ id: 'process-after-tool' }),
      ],
    })
  })

  test('promotes the matching final process block instead of duplicating it', () => {
    const turns = reduceRuntimeConversationTurns(
      [
        {
          id: 'turn-1',
          items: [
            {
              id: 'cpu-progress',
              type: 'block',
              block: {
                id: 'cpu-progress',
                subtaskId: 'turn-1',
                type: 'text',
                content: 'CPU 检查完成。',
                status: 'done',
                createdAt: Date.parse('2026-08-03T00:00:00.000Z'),
              },
            },
            {
              id: 'memory-final',
              type: 'block',
              block: {
                id: 'memory-final',
                subtaskId: 'turn-1',
                type: 'text',
                content: '内存检查完成。',
                status: 'done',
                createdAt: Date.parse('2026-08-03T00:00:01.000Z'),
              },
            },
          ],
          status: 'streaming',
        },
      ],
      {
        type: 'assistant_done',
        subtaskId: 'turn-1',
        content: '内存检查完成。',
      }
    )

    expect(turns[0].items).toEqual([
      expect.objectContaining({ id: 'cpu-progress', type: 'block' }),
      expect.objectContaining({
        id: 'runtime-final:turn-1',
        type: 'assistant_text',
        content: '内存检查完成。',
      }),
    ])
    expect(projectRuntimeConversationTurns(turns)[0]).toMatchObject({
      content: '内存检查完成。',
      blocks: [expect.objectContaining({ id: 'cpu-progress' })],
    })
  })

  test('keeps streamed final text when terminal content is already present', () => {
    const turns = reduceRuntimeConversationTurns(
      [
        {
          id: 'turn-1',
          items: [
            {
              id: 'streamed-final',
              type: 'assistant_text',
              content: 'Partial final',
              createdAt: '2026-08-03T00:00:00.000Z',
            },
          ],
          status: 'streaming',
        },
      ],
      {
        type: 'assistant_done',
        subtaskId: 'turn-1',
        content: 'Complete final',
      }
    )

    expect(turns[0].items).toEqual([
      expect.objectContaining({
        id: 'streamed-final',
        type: 'assistant_text',
        content: 'Partial final',
      }),
    ])
  })

  test('clears terminal metadata when the same Codex turn starts again', () => {
    const turns = reduceRuntimeConversationTurns(
      [
        {
          id: 'turn-1',
          items: [],
          status: 'failed',
          completedAt: '2026-07-30T00:00:01.000Z',
          error: 'Disconnected',
          errorType: 'response.failed',
          stoppedNotice: true,
        },
      ],
      {
        type: 'assistant_started',
        subtaskId: 'turn-1',
      }
    )

    expect(turns[0]).toMatchObject({
      id: 'turn-1',
      status: 'streaming',
    })
    expect(turns[0].completedAt).toBeUndefined()
    expect(turns[0].error).toBeUndefined()
    expect(turns[0].errorType).toBeUndefined()
    expect(turns[0].stoppedNotice).toBeUndefined()
  })

  test('keeps local realtime items missing from a partial snapshot', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: {
              ...userMessage('client-user-1', 'Local prompt'),
              subtaskId: 'turn-1',
              turnId: 'turn-1',
            },
          },
          {
            id: 'request-1',
            type: 'block',
            block: requestBlock('request-1', 'turn-1'),
          },
        ],
        status: 'streaming',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: {
              ...userMessage('client-user-1', 'Snapshot prompt'),
              subtaskId: 'turn-1',
              turnId: 'turn-1',
            },
          },
        ],
        status: 'streaming',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged[0].items.map(item => item.id)).toEqual(['client-user-1', 'request-1'])
    expect(merged[0].items.find(item => item.id === 'client-user-1')).toMatchObject({
      message: { content: 'Snapshot prompt' },
    })
    expect(projectRuntimeConversationTurns(merged)[1].blocks?.[0].id).toBe('request-1')
  })

  test('converges full Codex snapshot items by exact item id', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: {
              ...userMessage('client-user-1', 'Prompt'),
              subtaskId: 'turn-1',
              turnId: 'turn-1',
            },
          },
          {
            id: 'item-2',
            type: 'assistant_text',
            content: 'Streaming answer',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
        ],
        status: 'done',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: {
              ...userMessage('client-user-1', 'Prompt'),
              subtaskId: 'turn-1',
              turnId: 'turn-1',
            },
          },
          {
            id: 'item-2',
            type: 'assistant_text',
            content: 'Answer',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
        ],
        status: 'done',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged[0].items.map(item => item.id)).toEqual(['client-user-1', 'item-2'])
    expect(projectRuntimeConversationTurns(merged).map(message => message.content)).toEqual([
      'Prompt',
      'Answer',
    ])
  })

  test('uses a complete legacy snapshot instead of retaining reissued process items', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: userMessage('client-user-1', 'Prompt'),
          },
          {
            id: 'rs-realtime-1',
            type: 'block',
            block: {
              id: 'rs-realtime-1',
              subtaskId: 'turn-1',
              type: 'thinking',
              content: 'Checking',
              status: 'done',
              createdAt: 1,
            },
          },
          {
            id: 'call-1',
            type: 'block',
            block: {
              id: 'call-1',
              subtaskId: 'turn-1',
              type: 'tool',
              toolName: 'exec_command',
              status: 'done',
              createdAt: 2,
            },
          },
        ],
        status: 'done',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: userMessage('client-user-1', 'Prompt'),
          },
          {
            id: 'item-2',
            type: 'block',
            block: {
              id: 'item-2',
              subtaskId: 'turn-1',
              type: 'thinking',
              content: 'Checking',
              status: 'done',
              createdAt: 1,
            },
          },
          {
            id: 'call-1',
            type: 'block',
            block: {
              id: 'call-1',
              subtaskId: 'turn-1',
              type: 'tool',
              toolName: 'exec_command',
              status: 'done',
              createdAt: 2,
            },
          },
        ],
        status: 'done',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged[0].items).toEqual(snapshot[0].items)
    expect(merged[0].items.map(item => item.id)).toEqual(['client-user-1', 'item-2', 'call-1'])
  })

  test('converges a lagging legacy final answer onto the realtime Codex item', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'process-1',
            type: 'block',
            block: requestBlock('process-1', 'turn-1'),
          },
          {
            id: 'msg-realtime-1',
            type: 'assistant_text',
            content: 'Final answer',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
        ],
        status: 'streaming',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'item-1',
            type: 'assistant_text',
            content: 'Final answer',
            createdAt: '2026-07-30T00:00:02.000Z',
          },
        ],
        status: 'done',
      },
    ]

    expect(mergeRuntimeConversationTurns(local, snapshot)[0].items).toEqual([
      local[0].items[0],
      {
        ...snapshot[0].items[0],
        id: 'msg-realtime-1',
      },
    ])
  })

  test('appends an unmatched final answer from a lagging legacy snapshot', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'process-1',
            type: 'block',
            block: requestBlock('process-1', 'turn-1'),
          },
          {
            id: 'msg-realtime-1',
            type: 'assistant_text',
            content: 'First answer',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
        ],
        status: 'streaming',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'item-1',
            type: 'assistant_text',
            content: 'Different answer',
            createdAt: '2026-07-30T00:00:02.000Z',
          },
        ],
        status: 'done',
      },
    ]

    expect(mergeRuntimeConversationTurns(local, snapshot)[0].items).toEqual([
      ...local[0].items,
      snapshot[0].items[0],
    ])
  })

  test('keeps realtime tail items temporarily missing from a full Codex snapshot', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'snapshot-item',
            type: 'assistant_text',
            content: 'First',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
          {
            id: 'live-tail-item',
            type: 'assistant_text',
            content: 'Second',
            createdAt: '2026-07-30T00:00:02.000Z',
          },
        ],
        status: 'streaming',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'snapshot-item',
            type: 'assistant_text',
            content: 'First from snapshot',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
        ],
        status: 'streaming',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged[0].items.map(item => item.id)).toEqual(['snapshot-item', 'live-tail-item'])
    expect(merged[0].items[0]).toMatchObject({ content: 'First from snapshot' })
  })

  test('binds a missed optimistic start from the snapshot by exact client user message id', () => {
    const local = reduceRuntimeConversationTurns([], {
      type: 'user_added',
      message: userMessage('client-user-1', 'Local prompt'),
    })
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        clientUserMessageId: 'client-user-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: {
              ...userMessage('client-user-1', 'Snapshot prompt'),
              subtaskId: 'turn-1',
              turnId: 'turn-1',
            },
          },
        ],
        status: 'streaming',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'turn-1',
      clientUserMessageId: 'client-user-1',
      status: 'streaming',
    })
    expect(merged[0].items).toHaveLength(1)
    expect(merged[0].items[0]).toMatchObject({
      id: 'client-user-1',
      message: { content: 'Snapshot prompt' },
    })
  })

  test('drops an optimistic guidance turn once the snapshot contains the same client message id', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: userMessage('client-user-1', 'Initial prompt'),
          },
        ],
        status: 'streaming',
      },
      {
        id: null,
        clientUserMessageId: 'client-guidance-1',
        items: [
          {
            id: 'client-guidance-1',
            type: 'user_message',
            message: userMessage('client-guidance-1', 'Updated direction'),
          },
        ],
        status: 'pending',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'client-user-1',
            type: 'user_message',
            message: userMessage('client-user-1', 'Initial prompt'),
          },
          {
            id: 'client-guidance-1',
            type: 'user_message',
            message: userMessage('client-guidance-1', 'Updated direction'),
          },
        ],
        status: 'streaming',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged).toHaveLength(1)
    expect(merged[0].items.map(item => item.id)).toEqual(['client-user-1', 'client-guidance-1'])
    expect(
      projectRuntimeConversationTurns(merged).filter(message => message.id === 'client-guidance-1')
    ).toHaveLength(1)
  })

  test('keeps an optimistic guidance turn while the snapshot does not contain its id', () => {
    const optimisticGuidance = reduceRuntimeConversationTurns([], {
      type: 'user_added',
      message: userMessage('client-guidance-1', 'Updated direction'),
    })
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [],
        status: 'streaming',
      },
    ]

    expect(mergeRuntimeConversationTurns(optimisticGuidance, snapshot)).toEqual([
      snapshot[0],
      optimisticGuidance[0],
    ])
  })

  test('moves optimistic guidance into its real turn by exact client message id', () => {
    const turns = reduceRuntimeConversationTurns(
      [{ id: 'turn-1', items: [], status: 'streaming' }],
      {
        type: 'user_added',
        message: userMessage('client-guidance-1', 'Updated direction'),
      }
    )

    const merged = appendRuntimeConversationGuidance(turns, 'turn-1', {
      ...userMessage('client-guidance-1', 'Updated direction'),
      role: 'user',
      runtimeGuidance: true,
    })

    expect(merged).toHaveLength(1)
    expect(merged[0].items).toEqual([
      expect.objectContaining({
        id: 'client-guidance-1',
        type: 'user_message',
        message: expect.objectContaining({
          runtimeGuidance: true,
          subtaskId: 'turn-1',
          turnId: 'turn-1',
        }),
      }),
    ])
  })

  test('uses snapshot turn order without sorting turn ids', () => {
    const local: RuntimeConversationTurn[] = [
      { id: 'turn-z', items: [], status: 'streaming' },
      { id: 'turn-a', items: [], status: 'streaming' },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      { id: 'turn-a', items: [], status: 'done' },
      { id: 'turn-z', items: [], status: 'done' },
    ]

    expect(mergeRuntimeConversationTurns(local, snapshot).map(turn => turn.id)).toEqual([
      'turn-a',
      'turn-z',
    ])
  })

  test('keeps an older stopped local turn before a newer snapshot turn', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-stopped',
        runtimeMessageIndex: 10,
        items: [
          {
            id: 'client-user-stopped',
            type: 'user_message',
            message: {
              ...userMessage('client-user-stopped', 'Stopped prompt'),
              createdAt: '2026-07-30T00:00:10.000Z',
            },
          },
        ],
        status: 'cancelled',
        stoppedNotice: true,
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-new',
        runtimeMessageIndex: 12,
        items: [
          {
            id: 'assistant-new',
            type: 'assistant_text',
            content: 'New response',
            createdAt: '2026-07-30T00:00:12.000Z',
          },
        ],
        status: 'streaming',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged.map(turn => turn.id)).toEqual(['turn-stopped', 'turn-new'])
    expect(projectRuntimeConversationTurns(merged).at(-1)).toMatchObject({
      content: 'New response',
      status: 'streaming',
    })
  })

  test('uses turn timestamps when only one side has a transcript message index', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-stopped',
        items: [
          {
            id: 'client-user-stopped',
            type: 'user_message',
            message: {
              ...userMessage('client-user-stopped', 'Stopped prompt'),
              createdAt: '2026-07-30T00:00:10.000Z',
            },
          },
        ],
        status: 'cancelled',
        stoppedNotice: true,
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-new',
        runtimeMessageIndex: 12,
        items: [
          {
            id: 'assistant-new',
            type: 'assistant_text',
            content: 'New response',
            createdAt: '2026-07-30T00:00:12.000Z',
          },
        ],
        status: 'streaming',
      },
    ]

    expect(mergeRuntimeConversationTurns(local, snapshot).map(turn => turn.id)).toEqual([
      'turn-stopped',
      'turn-new',
    ])
  })

  test('converges a local item in place when the snapshot contains the same item id', () => {
    const localBlock = requestBlock('request-1', 'turn-1')
    const snapshotBlock = { ...localBlock, status: 'done' as const }
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [{ id: 'request-1', type: 'block', block: localBlock }],
        status: 'streaming',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [{ id: 'request-1', type: 'block', block: snapshotBlock }],
        status: 'done',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)

    expect(merged).toHaveLength(1)
    expect(merged[0].items).toEqual([{ id: 'request-1', type: 'block', block: snapshotBlock }])
    expect(merged[0].status).toBe('done')
  })

  test('preserves completed tool timing when a conversation snapshot is restored', () => {
    const localBlock: ProcessingBlock = {
      id: 'tool-1',
      subtaskId: 'turn-1',
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
      status: 'done',
      createdAt: 1_770_000_000_000,
      completedAt: 1_770_000_004_250,
    }
    const snapshotBlock: ProcessingBlock = {
      ...localBlock,
      createdAt: 1_770_000_005_000,
      completedAt: undefined,
    }
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [{ id: localBlock.id, type: 'block', block: localBlock }],
        status: 'done',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [{ id: snapshotBlock.id, type: 'block', block: snapshotBlock }],
        status: 'done',
      },
    ]

    const mergedBlock = mergeRuntimeConversationTurns(local, snapshot)[0].items[0]

    expect(mergedBlock).toEqual({
      id: localBlock.id,
      type: 'block',
      block: {
        ...snapshotBlock,
        createdAt: localBlock.createdAt,
        completedAt: localBlock.completedAt,
      },
    })
  })

  test('records tool completion time in runtime conversation state', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-03T13:00:04.250Z'))
      const createdAt = new Date('2026-08-03T13:00:00.000Z').getTime()
      let turns = reduceRuntimeConversationTurns(
        [{ id: 'turn-1', items: [], status: 'streaming' }],
        {
          type: 'block_created',
          subtaskId: 'turn-1',
          block: {
            id: 'tool-1',
            subtaskId: 'turn-1',
            type: 'tool',
            toolName: 'bash',
            toolInput: { command: 'pwd' },
            status: 'streaming',
            createdAt,
          },
        }
      )

      turns = reduceRuntimeConversationTurns(turns, {
        type: 'block_updated',
        subtaskId: 'turn-1',
        blockId: 'tool-1',
        updates: { status: 'done' },
      })

      expect(turns[0].items[0]).toMatchObject({
        type: 'block',
        block: {
          createdAt,
          completedAt: new Date('2026-08-03T13:00:04.250Z').getTime(),
          status: 'done',
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps a live Codex turn failure when the provider snapshot omits the failure', () => {
    const local = reduceRuntimeConversationTurns(
      [
        {
          id: 'turn-1',
          items: [],
          status: 'streaming',
        },
      ],
      {
        type: 'assistant_error',
        subtaskId: 'turn-1',
        error: 'Context window exceeded',
        errorType: 'response.failed',
      }
    )
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [],
        status: 'done',
      },
    ]

    const merged = mergeRuntimeConversationTurns(local, snapshot)
    const [message] = projectRuntimeConversationTurns(merged)

    expect(merged[0].status).toBe('failed')
    expect(merged[0].items).toEqual([])
    expect(message).toMatchObject({
      status: 'failed',
      runtimeStatus: 'failed',
      error: 'Context window exceeded',
      errorType: 'response.failed',
    })
  })

  test('projects guidance boundaries from ordered turn items', () => {
    const guidance = {
      ...userMessage('client-guidance-1', 'Use the second approach'),
      role: 'user' as const,
      runtimeGuidance: true,
      subtaskId: 'turn-1',
      turnId: 'turn-1',
    }
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'assistant-item-1',
            type: 'assistant_text',
            content: 'Before',
            createdAt: '2026-07-30T00:00:01.000Z',
          },
          { id: guidance.id, type: 'user_message', message: guidance },
          {
            id: 'assistant-item-2',
            type: 'assistant_text',
            content: 'After',
            createdAt: '2026-07-30T00:00:02.000Z',
          },
        ],
        status: 'streaming',
      },
    ]

    const messages = projectRuntimeConversationTurns(turns)

    expect(messages.map(message => [message.role, message.content])).toEqual([
      ['assistant', 'Before'],
      ['user', 'Use the second approach'],
      ['assistant', 'After'],
    ])
    expect(messages[0].runtimeGuidanceSplitBefore).toBe(true)
    expect(messages[2].runtimeGuidanceContinuation).toBe(true)
  })

  test('rejects assistant text that has no Codex item identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const turns = reduceRuntimeConversationTurns(
      [{ id: 'turn-1', items: [], status: 'streaming' }],
      {
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        content: 'unidentified',
      }
    )

    expect(turns[0].items).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Dropped runtime assistant text without Codex item identity',
      { subtaskId: 'turn-1' }
    )
    warn.mockRestore()
  })

  test('preserves reasoning chunks as one streaming thinking block', () => {
    let turns = reduceRuntimeConversationTurns([{ id: 'turn-1', items: [], status: 'streaming' }], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      content: '',
      reasoningChunk: 'Reading files',
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      content: '',
      reasoningChunk: ' and checking tests',
    })

    expect(turns[0].items).toEqual([
      expect.objectContaining({
        id: 'runtime-reasoning:turn-1',
        type: 'block',
        block: expect.objectContaining({
          type: 'thinking',
          content: 'Reading files and checking tests',
          status: 'streaming',
        }),
      }),
    ])
    expect(turns[0].streamingThinkingContent).toBe('Reading files and checking tests')
    expect(projectRuntimeConversationTurns(turns)[0].streamingThinkingContent).toBe(
      'Reading files and checking tests'
    )
  })

  test('atomically moves final text reclassified as commentary into a process block', () => {
    let turns = reduceRuntimeConversationTurns([{ id: 'turn-1', items: [], status: 'streaming' }], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'msg-progress',
      content: 'I will inspect.',
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'block_created',
      subtaskId: 'turn-1',
      replaceAssistantTextItemId: 'msg-progress',
      block: {
        id: 'msg-progress',
        subtaskId: 'turn-1',
        type: 'text',
        content: 'I will inspect.',
        status: 'done',
        createdAt: 1770000000000,
      },
    })

    expect(turns[0].items).toEqual([
      {
        id: 'msg-progress',
        type: 'block',
        block: expect.objectContaining({
          id: 'msg-progress',
          type: 'text',
          content: 'I will inspect.',
        }),
      },
    ])
    expect(projectRuntimeConversationTurns(turns)).toEqual([
      expect.objectContaining({
        content: '',
        blocks: [
          expect.objectContaining({
            id: 'msg-progress',
            type: 'text',
            content: 'I will inspect.',
          }),
        ],
      }),
    ])
  })

  test('clears the active reasoning summary when final text starts streaming', () => {
    let turns = reduceRuntimeConversationTurns([{ id: 'turn-1', items: [], status: 'streaming' }], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      content: '',
      reasoningChunk: 'Checking the implementation',
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'The fix is ready.',
    })

    expect(turns[0].streamingThinkingContent).toBeUndefined()
    expect(projectRuntimeConversationTurns(turns)[0].streamingThinkingContent).toBeUndefined()
  })

  test('clears stale reasoning when cached assistant content is applied', () => {
    const turns = reduceRuntimeConversationTurns(
      [
        {
          id: 'turn-1',
          items: [],
          status: 'streaming',
          streamingThinkingContent: 'Old reasoning',
        },
      ],
      {
        type: 'assistant_cached',
        subtaskId: 'turn-1',
        content: 'Cached answer',
        blocks: [],
      }
    )

    expect(turns[0].streamingThinkingContent).toBeUndefined()
  })

  test('keeps the active reasoning summary across a tool continuation', () => {
    let turns = reduceRuntimeConversationTurns([{ id: 'turn-1', items: [], status: 'streaming' }], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      content: '',
      reasoningChunk: 'Checking the implementation',
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'I will inspect the files.',
    })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      content: '',
      blocks: [
        {
          id: 'tool-1',
          subtaskId: 'turn-1',
          type: 'tool',
          toolName: 'bash',
          toolInput: { command: 'pwd' },
          status: 'pending',
          createdAt: 1770000000000,
        },
      ],
    })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_started',
      subtaskId: 'turn-1',
    })

    expect(turns[0].streamingThinkingContent).toBe('Checking the implementation')
  })

  test('recomputes the reasoning summary from merged streaming items', () => {
    const local: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'thinking-1',
            type: 'block',
            block: {
              id: 'thinking-1',
              subtaskId: 'turn-1',
              type: 'thinking',
              content: 'Old reasoning',
              status: 'streaming',
              createdAt: 1,
            },
          },
          {
            id: 'tool-1',
            type: 'block',
            block: {
              id: 'tool-1',
              subtaskId: 'turn-1',
              type: 'tool',
              toolName: 'bash',
              toolInput: { command: 'pwd' },
              status: 'streaming',
              createdAt: 2,
            },
          },
        ],
        status: 'streaming',
        streamingThinkingContent: 'Old reasoning',
      },
    ]
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        items: [
          {
            id: 'thinking-1',
            type: 'block',
            block: {
              id: 'thinking-1',
              subtaskId: 'turn-1',
              type: 'thinking',
              content: 'Updated reasoning',
              status: 'streaming',
              createdAt: 1,
            },
          },
        ],
        status: 'streaming',
      },
    ]

    expect(mergeRuntimeConversationTurns(local, snapshot)[0].streamingThinkingContent).toBe(
      'Updated reasoning'
    )
  })

  test('uses UTF-16 code-unit offsets when replacing streamed text', () => {
    let turns = reduceRuntimeConversationTurns([{ id: 'turn-1', items: [], status: 'streaming' }], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'A😀B',
      offset: 0,
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: '😎',
      offset: 1,
    })

    expect(turns[0].items).toEqual([
      expect.objectContaining({
        type: 'assistant_text',
        content: 'A😎B',
        streamTextOffset: 3,
      }),
    ])
  })

  test('replaces a streamed item with the completed snapshot by exact item id', () => {
    let turns = reduceRuntimeConversationTurns([{ id: 'turn-1', items: [], status: 'streaming' }], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'Partial',
      offset: 0,
    })

    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'Complete answer',
      contentMode: 'snapshot',
    })

    expect(turns[0].items).toEqual([
      expect.objectContaining({
        id: 'message-1',
        type: 'assistant_text',
        content: 'Complete answer',
        streamTextOffset: undefined,
      }),
    ])
  })
})
