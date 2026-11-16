import assert from 'node:assert/strict'
import { test } from 'vitest'
import { hasPersistedInteractionAnswer } from '../e2e/desktop/scenarios/interaction-reminder-device-scope.scenario.mjs'

const expected = {
  taskId: 'remote-task',
  question: 'Should the remote review continue?',
  answer: 'Keep the current remote policy.',
}

function questionItem(overrides = {}) {
  return {
    id: 'question-item',
    type: 'block',
    block: {
      type: 'tool',
      render_payload: {
        kind: 'request_user_input',
        requestId: 1,
        itemId: 'question-call',
        interactionScope: 'remote-turn',
        interactionStatus: 'answered',
        questions: [{ id: 'policy', question: expected.question }],
        response: {
          requestId: 1,
          itemId: 'question-call',
          interactionScope: 'remote-turn',
          answers: { policy: { answers: [expected.answer] } },
        },
        ...overrides,
      },
    },
  }
}

function transcript(item, runtimeItem) {
  return {
    taskId: expected.taskId,
    messages: [],
    turns: [{ id: 'remote-turn', items: item ? [item] : [] }],
    runtimeTurns: runtimeItem ? [{ id: 'remote-turn', items: [runtimeItem] }] : [],
  }
}

test('accepts the exact native answer or the runtime-owned answer overlay', () => {
  assert.equal(hasPersistedInteractionAnswer(transcript(questionItem()), expected), true)
  assert.equal(hasPersistedInteractionAnswer(transcript(null, questionItem()), expected), true)
})

test('a pending runtime overlay supersedes an older native answered item', () => {
  const value = transcript(
    questionItem(),
    questionItem({ interactionStatus: 'pending', response: undefined })
  )
  assert.equal(hasPersistedInteractionAnswer(value, expected), false)
})

test('rejects another task, question, answer, or request identity', () => {
  const correct = transcript(null, questionItem())
  assert.equal(hasPersistedInteractionAnswer({ ...correct, taskId: 'local-task' }, expected), false)
  for (const overrides of [
    { questions: [{ id: 'policy', question: 'Another question' }] },
    { requestId: 2 },
    { itemId: 'another-call' },
    { interactionScope: 'another-turn' },
    {
      response: {
        requestId: 1,
        itemId: 'question-call',
        interactionScope: 'remote-turn',
        answers: { policy: { answers: ['Use the old policy.'] } },
      },
    },
  ]) {
    assert.equal(
      hasPersistedInteractionAnswer(transcript(null, questionItem(overrides)), expected),
      false
    )
  }
})

test('async questions require a persisted user reply instead of an assistant mention', () => {
  const value = transcript(null, questionItem({ delivery: 'async', response: undefined }))
  value.messages = [{ role: 'assistant', content: expected.answer }]
  assert.equal(hasPersistedInteractionAnswer(value, expected), false)
  value.messages = [{ role: 'user', content: `Policy: ${expected.answer}` }]
  assert.equal(hasPersistedInteractionAnswer(value, expected), true)
})
