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
