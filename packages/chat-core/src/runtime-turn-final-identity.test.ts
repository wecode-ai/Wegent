import { expect, test } from 'vitest'
import type { RuntimeConversationTurn } from './runtime-conversation'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from './runtime-conversation-turns'

const content = 'The complete answer'
const nativeId = 'wework-e2e-response-2-message'

test.each(['assistant_text', 'block'] as const)(
  'completion updates an existing %s before a late native user item',
  type => {
    const output =
      type === 'assistant_text'
        ? { id: nativeId, position: 0, type, content: 'The complete' }
        : {
            id: nativeId,
            position: 0,
            type,
            block: {
              id: nativeId,
              type: 'text' as const,
              content: 'The complete',
              status: 'streaming' as const,
              createdAt: 1,
            },
          }
    const turn: RuntimeConversationTurn = {
      id: 'turn-1',
      status: 'streaming',
      items: [
        output,
        {
          id: 'native-user',
          position: 1,
          type: 'user_message',
          message: {
            id: 'client-user',
            role: 'user',
            content: 'Question',
            status: 'done',
            createdAt: '2026-11-02T23:38:33.000Z',
          },
        },
      ],
    }
    const completed = reduceRuntimeConversationTurns([turn], {
      type: 'assistant_done',
      subtaskId: 'turn-1',
      itemId: nativeId,
      content,
    })
    expect.soft(completed[0].items.map(item => item.id)).toEqual([nativeId, 'native-user'])
    expect.soft(completed[0].items[0]).toMatchObject({
      id: nativeId,
      position: 0,
      type: 'assistant_text',
      content,
    })
    const native: RuntimeConversationTurn = {
      ...turn,
      status: 'done',
      items: [{ id: nativeId, position: 0, type: 'assistant_text', content }, turn.items[1]],
    }
    const hydrated = mergeRuntimeConversationTurns(completed, [native])
    expect(hydrated[0].items).toEqual(native.items)
    expect(projectRuntimeConversationTurns(hydrated).map(message => message.content)).toEqual([
      content,
      'Question',
    ])
  }
)

test('completion replaces a partial process item by native identity before history arrives', () => {
  const streaming: RuntimeConversationTurn = {
    id: 'turn-1',
    status: 'streaming',
    items: [
      {
        id: nativeId,
        position: 3,
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
  const completed = reduceRuntimeConversationTurns([streaming], {
    type: 'assistant_done',
    subtaskId: 'turn-1',
    itemId: nativeId,
    content,
  })
  expect.soft(completed[0].items).toEqual([
    expect.objectContaining({
      id: nativeId,
      position: 3,
      type: 'assistant_text',
      content,
    }),
  ])
  const native: RuntimeConversationTurn = {
    id: 'turn-1',
    status: 'done',
    items: [{ id: nativeId, type: 'assistant_text', content, position: 3 }],
  }
  const hydrated = mergeRuntimeConversationTurns(completed, [native])
  expect.soft(hydrated[0].items).toEqual(native.items)
  expect(projectRuntimeConversationTurns(hydrated)[0].content).toBe(content)
})

test('an explicit final identity preserves a different process item with identical text', () => {
  const streaming: RuntimeConversationTurn = {
    id: 'turn-1',
    status: 'streaming',
    items: [
      {
        id: 'earlier-process',
        type: 'block',
        block: {
          id: 'earlier-process',
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
    itemId: nativeId,
    content,
  })
  expect(completed[0].items.map(item => ({ id: item.id, type: item.type }))).toEqual([
    { id: 'earlier-process', type: 'block' },
    { id: nativeId, type: 'assistant_text' },
  ])
})

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
