import { expect, test } from 'vitest'
import type { RuntimeConversationTurn } from './runtime-conversation'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from './runtime-conversation-turns'

const content = 'The complete answer'
const nativeId = 'wework-e2e-response-2-message'

test('completion retains a process item identity before native history hydration', () => {
  const streaming: RuntimeConversationTurn = {
    id: 'turn-1',
    status: 'streaming',
    items: [
      {
        id: nativeId,
        type: 'block',
        block: {
          id: nativeId,
          type: 'text',
          content,
          status: 'done',
          createdAt: 1,
        },
      },
    ],
  }
  const completed = reduceRuntimeConversationTurns([streaming], {
    type: 'assistant_done',
    subtaskId: 'turn-1',
    content,
  })
  const native: RuntimeConversationTurn = {
    id: 'turn-1',
    status: 'done',
    position: 0,
    items: [{ id: nativeId, type: 'assistant_text', content, position: 0 }],
  }
  expect.soft(completed[0].items.map(item => item.id)).toEqual([nativeId])
  const hydrated = mergeRuntimeConversationTurns(completed, [native])
  expect.soft(hydrated[0].items).toEqual(native.items)
  expect(projectRuntimeConversationTurns(hydrated)[0].content).toBe(content)
})

test('native history retains distinct output items with identical content', () => {
  const turn: RuntimeConversationTurn = {
    id: 'turn-1',
    status: 'done',
    items: [
      { id: 'first', type: 'assistant_text', content, position: 0 },
      { id: 'second', type: 'assistant_text', content, position: 1 },
    ],
  }
  expect(mergeRuntimeConversationTurns([turn], [turn])[0].items).toEqual(turn.items)
  expect(projectRuntimeConversationTurns([turn])[0].content).toBe(`${content}\n\n${content}`)
})

test.each(['assistant_chunk', 'assistant_done'] as const)(
  'a late %s process block cannot duplicate a native assistant item',
  type => {
    const native: RuntimeConversationTurn = {
      id: 'turn-1',
      status: 'streaming',
      items: [{ id: nativeId, type: 'assistant_text', content, position: 0 }],
    }
    const observed = reduceRuntimeConversationTurns([native], {
      type,
      subtaskId: 'turn-1',
      blocks: [
        {
          id: nativeId,
          type: 'text',
          content: 'The complete',
          status: 'streaming',
          createdAt: 1,
        },
      ],
    })
    expect.soft(observed[0].items.map(item => item.id)).toEqual([nativeId])
    const hydrated = mergeRuntimeConversationTurns(observed, [{ ...native, status: 'done' }])
    expect.soft(hydrated[0].items).toEqual(native.items)
    expect(projectRuntimeConversationTurns(hydrated)[0].content).toBe(content)
  }
)

test.each(['snapshot', 'delta'] as const)(
  'a final %s text update replaces its native process representation',
  contentMode => {
    const native: RuntimeConversationTurn = {
      id: 'turn-1',
      status: 'streaming',
      items: [
        {
          id: nativeId,
          position: 0,
          type: 'block',
          block: {
            id: nativeId,
            type: 'text',
            content: 'The complete',
            status: 'streaming',
            createdAt: 1,
          },
        },
      ],
    }
    const observed = reduceRuntimeConversationTurns([native], {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: nativeId,
      content: contentMode === 'snapshot' ? content : ' answer',
      contentMode,
      offset: contentMode === 'snapshot' ? undefined : 'The complete'.length,
    })
    expect(observed[0].items).toEqual([
      expect.objectContaining({ id: nativeId, type: 'assistant_text', content, position: 0 }),
    ])
    expect(projectRuntimeConversationTurns(observed)[0].content).toBe(content)
  }
)
