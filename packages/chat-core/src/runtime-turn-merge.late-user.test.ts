import { expect, test } from 'vitest'
import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from './runtime-conversation'
import { getLatestRuntimeLiveActivityFromTurns } from './runtime-thinking'
import { mergeRuntimeConversationTurns } from './runtime-turns'

const progress: RuntimeConversationItem = {
  id: 'progress',
  type: 'block',
  block: {
    id: 'progress',
    type: 'text',
    content: 'Reply running',
    status: 'done',
    createdAt: 2,
  },
}

const prompt: RuntimeConversationItem = {
  id: 'prompt',
  type: 'user_message',
  message: { id: 'prompt', role: 'user', content: 'Continue' },
}

const turn = (items: RuntimeConversationItem[]): RuntimeConversationTurn => ({
  id: 'reply-turn',
  status: 'streaming',
  items,
})

test('a late initial prompt preserves in-flight progress without native positions', () => {
  const merged = mergeRuntimeConversationTurns(
    [turn([progress])],
    [turn([prompt])],
  )

  expect(merged[0]!.items.map((item) => item.id)).toEqual([
    'prompt',
    'progress',
  ])
  expect(getLatestRuntimeLiveActivityFromTurns(merged)).toMatchObject({
    active: true,
    processText: 'Reply running',
  })
})

test('later guidance retains its boundary and hides the earlier progress', () => {
  const guidance: RuntimeConversationItem = {
    ...prompt,
    message: { ...prompt.message, runtimeGuidance: true },
  }
  const merged = mergeRuntimeConversationTurns(
    [turn([progress])],
    [turn([guidance])],
  )

  expect(merged[0]!.items.map((item) => item.id)).toEqual([
    'progress',
    'prompt',
  ])
  expect(getLatestRuntimeLiveActivityFromTurns(merged).active).toBe(false)
})

test('confirmed native positions remain authoritative over prompt arrival', () => {
  const merged = mergeRuntimeConversationTurns(
    [turn([{ ...progress, position: 2 }])],
    [turn([{ ...prompt, position: 5 }])],
  )

  expect(merged[0]!.items.map((item) => item.id)).toEqual([
    'progress',
    'prompt',
  ])
  expect(getLatestRuntimeLiveActivityFromTurns(merged).active).toBe(false)
})
