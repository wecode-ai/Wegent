import { describe, expect, test } from 'vitest'
import { isPrimaryStandInConversation, isStandInMemoryReviewTask } from './runtime-task-visibility'

describe('memory review task visibility', () => {
  test('identifies scheduled memory maintenance by its stored origin', () => {
    expect(
      isStandInMemoryReviewTask({
        runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: true } },
      })
    ).toBe(true)
  })

  test.each([
    {},
    { runtimeHandle: { origin: null } },
    { runtimeHandle: { origin: [] } },
    { runtimeHandle: { origin: { type: 'stand_in_schedule', weeklyReview: true } } },
    { runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: false } } },
    { runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: 'true' } } },
    { runtimeHandle: { origin: { type: 'stand_in_task', memoryReview: true } } },
  ])('keeps unrelated or incomplete origins visible: %j', task => {
    expect(isStandInMemoryReviewTask(task)).toBe(false)
  })
})

describe('primary stand-in conversation visibility', () => {
  const primary = {
    taskId: 'stand-in-chat-7-primary',
    runtimeHandle: {
      origin: { type: 'stand_in_identity', userId: 7, standInId: null },
    },
  }

  test('identifies the canonical primary conversation from its saved identity', () => {
    expect(isPrimaryStandInConversation(primary)).toBe(true)
    expect(
      isPrimaryStandInConversation({
        taskId: 'stand-in-chat-0-primary',
        runtimeHandle: { origin: { type: 'stand_in_identity', userId: 0 } },
      })
    ).toBe(true)
  })

  test.each([
    { taskId: 'stand-in-chat-7-primary' },
    { ...primary, taskId: 'different-conversation' },
    { ...primary, runtimeHandle: { origin: { type: 'stand_in_task', userId: 7 } } },
    {
      ...primary,
      runtimeHandle: {
        origin: { type: 'stand_in_identity', userId: 7, standInId: 'default' },
      },
    },
    { ...primary, runtimeHandle: { origin: { type: 'stand_in_identity', userId: 8 } } },
    { ...primary, runtimeHandle: { origin: { type: 'stand_in_identity', userId: '7' } } },
  ])('keeps unrelated and incomplete task identities visible: %j', task => {
    expect(isPrimaryStandInConversation(task)).toBe(false)
  })
})
