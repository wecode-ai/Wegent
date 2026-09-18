import { describe, expect, it } from 'vitest'
import { runtimeExecutionSnapshot } from './runtime-execution-snapshot'
import type { RuntimeTranscriptResponse } from './runtime'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const transcript = (status?: string): RuntimeTranscriptResponse => ({
  taskId: 'task-1',
  workspacePath: '/workspace',
  runtime: 'claude_code',
  running: false,
  messages: [],
  rangeStart: 0,
  hasMoreBefore: false,
  hasMoreAfter: false,
  turns: [
    {
      id: 'turn-1',
      status,
      completedAt: 1789572084984,
      items: [
        {
          id: 'native-user',
          type: 'user_message',
          message: {
            id: 'native-user',
            clientUserMessageId: 'trigger-1',
            role: 'user',
            content: 'Private prompt',
          },
        },
        {
          id: 'assistant-1',
          type: 'assistant_text',
          content: 'Private response',
        },
      ],
    },
  ],
})

describe('runtime execution snapshot', () => {
  it('reports terminal facts and stable trigger IDs without conversation contents', () => {
    const snapshot = runtimeExecutionSnapshot(address, transcript('done'))
    expect(snapshot).toMatchObject({
      ...address,
      completeHistory: true,
      running: false,
      turns: [
        {
          id: 'turn-1',
          status: 'done',
          userMessageIds: ['trigger-1', 'native-user'],
        },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain('Private')
  })
  it.each([undefined, '', 'unknown', 'idle', 'running', 'streaming'])(
    'does not infer completion from %s',
    (status) => {
      expect(
        runtimeExecutionSnapshot(address, transcript(status)),
      ).toBeUndefined()
    },
  )
  it.each([
    ['failed', 'failed'],
    ['interrupted', 'cancelled'],
    ['cancelled', 'cancelled'],
  ])('preserves %s', (status, expected) => {
    expect(
      runtimeExecutionSnapshot(address, transcript(status))?.turns[0].status,
    ).toBe(expected)
  })
  it('does not call a paginated page a complete history', () => {
    expect(
      runtimeExecutionSnapshot(address, {
        ...transcript('done'),
        hasMoreAfter: true,
      })?.completeHistory,
    ).toBe(false)
    expect(
      runtimeExecutionSnapshot(address, {
        ...transcript('done'),
        hasMoreBefore: true,
      })?.completeHistory,
    ).toBe(false)
    expect(
      runtimeExecutionSnapshot(address, {
        ...transcript('done'),
        rangeStart: undefined,
      })?.completeHistory,
    ).toBe(false)
  })
  it('rejects incomplete reads and a mismatched task', () => {
    expect(
      runtimeExecutionSnapshot(address, {
        ...transcript('done'),
        historyUnavailable: true,
      }),
    ).toBeUndefined()
    expect(
      runtimeExecutionSnapshot(address, {
        ...transcript('done'),
        parseError: 'incomplete',
      }),
    ).toBeUndefined()
    expect(
      runtimeExecutionSnapshot(address, {
        ...transcript('done'),
        taskId: 'other',
      }),
    ).toBeUndefined()
  })
})
