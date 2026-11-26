import { expect, it } from 'vitest'
import { mergeRuntimeConversationTurns } from './runtime-turns'
import type { NormalizedRuntimeMessage } from './runtime'
import {
  runtimeMessageToWorkbenchMessage,
  runtimeTranscriptTurnsToConversationTurns,
} from './runtime-transcript'

function snapshot(
  source?: NormalizedRuntimeMessage['source'],
): NormalizedRuntimeMessage {
  return {
    id: 'native-activity',
    role: 'user',
    status: 'done',
    content:
      '委派任务 internal-task-42 已结束(done)。Read the task and report its result.',
    createdAt: '2026-11-05T09:00:00Z',
    source,
  }
}

it.each(['im', 'stand_in_activity', 'connection_event'])(
  'preserves explicit %s origin through both message and turn snapshot projection',
  (source) => {
    const original = snapshot({ source, taskId: 'internal-task-42' })
    const message = runtimeMessageToWorkbenchMessage(original)
    expect(message.source).toEqual(original.source)
    expect(message.content).toBe(original.content)
    const [turn] = runtimeTranscriptTurnsToConversationTurns([
      {
        id: 'native-turn',
        status: 'done',
        items: [{ id: original.id, type: 'user_message', message: original }],
      },
    ])
    expect(turn.items[0]).toMatchObject({
      type: 'user_message',
      message: { source: original.source, content: original.content },
    })
  },
)

it.each([
  undefined,
  { source: 'manual' },
  { source: 'stand_in_activity_extra' },
])(
  'does not infer host origin from message content or an unknown source: %j',
  (source) => {
    const original = snapshot(source)
    const projected = runtimeMessageToWorkbenchMessage(original)
    expect(projected.content).toBe(original.content)
    expect(projected.source).toBeUndefined()
  },
)

it('does not attach user activity metadata to an assistant result', () => {
  const projected = runtimeMessageToWorkbenchMessage({
    ...snapshot({ source: 'stand_in_activity' }),
    role: 'assistant',
    content: 'The actual business result',
  })
  expect(projected.role).toBe('assistant')
  expect(projected.content).toBe('The actual business result')
  expect(projected.source).toBeUndefined()
})

it('retains host event attribution when a later native snapshot omits it', () => {
  const original = snapshot({
    source: 'connection_event',
    sourceName: '发布文档',
  })
  const [host] = runtimeTranscriptTurnsToConversationTurns([
    {
      id: 'native-turn',
      status: 'done',
      items: [{ id: original.id, type: 'user_message', message: original }],
    },
  ])
  const [native] = runtimeTranscriptTurnsToConversationTurns([
    {
      id: 'native-turn',
      status: 'done',
      items: [
        {
          id: original.id,
          type: 'user_message',
          message: { ...original, source: undefined },
        },
      ],
    },
  ])
  const [merged] = mergeRuntimeConversationTurns([host], [native])
  expect(merged.items[0]).toMatchObject({
    type: 'user_message',
    message: { source: original.source },
  })
})

it('normalizes the executor’s numeric message timestamp for transcript consumers', () => {
  const original = { ...snapshot(), createdAt: Date.parse('2026-11-05T09:00:00Z') }
  const [turn] = runtimeTranscriptTurnsToConversationTurns([
    {
      id: 'native-turn',
      status: 'done',
      items: [{ id: original.id, type: 'user_message', message: original }],
    },
  ])
  expect(turn.items[0]).toMatchObject({
    type: 'user_message',
    message: { createdAt: '2026-11-05T09:00:00.000Z' },
  })
})
