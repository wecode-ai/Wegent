import { describe, expect, it } from 'vitest'
import type { RuntimeConversationTurn, RuntimePaneMessageAction } from './runtime-conversation'
import {
  hydrateRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from './runtime-conversation-turns'

const snapshot: RuntimeConversationTurn[] = [
  {
    id: 'turn',
    status: 'streaming',
    items: [{ id: 'message', type: 'assistant_text', content: 'Working', position: 3 }],
  },
]
const replacement: RuntimePaneMessageAction = {
  type: 'block_created',
  subtaskId: 'turn',
  replaceAssistantTextItemId: 'message',
  block: { id: 'message', type: 'text', content: 'Working', status: 'done', createdAt: 1 },
}

describe('classification during conversation hydration', () => {
  it.each([false, true])('keeps later live block updates (already applied: %s)', alreadyApplied => {
    const actions: RuntimePaneMessageAction[] = [
      replacement,
      {
        type: 'block_updated',
        subtaskId: 'turn',
        blockId: 'message',
        updates: { content: 'Updated process text' },
      },
    ]
    const observed = alreadyApplied
      ? actions.reduce(reduceRuntimeConversationTurns, snapshot)
      : snapshot

    const result = hydrateRuntimeConversationTurns(observed, snapshot, actions, alreadyApplied)

    expect(result[0].items).toEqual([
      expect.objectContaining({
        id: 'message',
        position: 3,
        type: 'block',
        block: expect.objectContaining({ content: 'Updated process text' }),
      }),
    ])
  })

  it('allows a later live final answer to supersede the process classification', () => {
    const result = hydrateRuntimeConversationTurns(snapshot, snapshot, [
      replacement,
      {
        type: 'assistant_chunk',
        subtaskId: 'turn',
        itemId: 'message',
        content: 'Final answer',
        contentMode: 'snapshot',
      },
    ])
    expect(result[0].items).toEqual([
      expect.objectContaining({ id: 'message', type: 'assistant_text', content: 'Final answer' }),
    ])
  })

  it('accepts native classification on a subsequent read without a live replacement', () => {
    const local = reduceRuntimeConversationTurns(snapshot, replacement)
    const result = hydrateRuntimeConversationTurns(local, snapshot, [])
    expect(result[0].items[0].type).toBe('assistant_text')
  })

  it('keeps native block classification and does not duplicate a persisted replacement', () => {
    const native: RuntimeConversationTurn[] = [
      {
        ...snapshot[0],
        items: [
          ...snapshot[0].items,
          {
            id: 'process',
            type: 'block',
            block: {
              id: 'process',
              type: 'text',
              content: 'Persisted process text',
              status: 'done',
              createdAt: 1,
            },
          },
        ],
      },
    ]
    const result = hydrateRuntimeConversationTurns(snapshot, native, [
      { ...replacement, block: { ...replacement.block, id: 'process' } },
    ])
    expect(result[0].items).toEqual([
      expect.objectContaining({
        id: 'process',
        type: 'block',
        block: expect.objectContaining({ content: 'Persisted process text' }),
      }),
    ])
  })

  it('does not apply another turn’s classification to matching text identities', () => {
    const other = { ...snapshot[0], id: 'other-turn' }
    const turns = [...snapshot, other]
    const result = hydrateRuntimeConversationTurns(turns, turns, [replacement])
    expect(result[0].items[0].type).toBe('block')
    expect(result[1].items).toEqual(other.items)
  })
})
