import { describe, expect, test } from 'vitest'
import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import { appendBufferedRuntimePaneMessageAction } from './runtimePaneMessageBuffer'

describe('appendBufferedRuntimePaneMessageAction', () => {
  test('coalesces thousands of contiguous text deltas into one action', () => {
    const actions: RuntimePaneMessageAction[] = []

    for (let offset = 0; offset < 2_200; offset += 1) {
      appendBufferedRuntimePaneMessageAction(actions, {
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        itemId: 'message-1',
        content: 'x',
        offset,
      })
    }

    expect(actions).toEqual([
      {
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        itemId: 'message-1',
        content: 'x'.repeat(2_200),
        offset: 0,
      },
    ])
  })

  test('does not merge text deltas across an offset gap', () => {
    const actions: RuntimePaneMessageAction[] = []

    appendBufferedRuntimePaneMessageAction(actions, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'hello',
      offset: 0,
    })
    appendBufferedRuntimePaneMessageAction(actions, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'world',
      offset: 9,
    })

    expect(actions).toHaveLength(2)
  })

  test('keeps terminal actions after the coalesced streaming content', () => {
    const actions: RuntimePaneMessageAction[] = []

    appendBufferedRuntimePaneMessageAction(actions, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: 'process-1',
      updates: { contentDelta: 'first', status: 'streaming' },
    })
    appendBufferedRuntimePaneMessageAction(actions, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: 'process-1',
      updates: { contentDelta: ' second', status: 'streaming' },
    })
    appendBufferedRuntimePaneMessageAction(actions, {
      type: 'assistant_done',
      subtaskId: 'turn-1',
    })

    expect(actions).toEqual([
      {
        type: 'block_updated',
        subtaskId: 'turn-1',
        blockId: 'process-1',
        updates: { contentDelta: 'first second', status: 'streaming' },
      },
      {
        type: 'assistant_done',
        subtaskId: 'turn-1',
      },
    ])
  })
})
