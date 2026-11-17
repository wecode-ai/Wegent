import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  assertRemoteQuestionCreated,
  hasPersistedInteractionAnswer,
} from '../e2e/desktop/scenarios/interaction-reminder-device-scope.scenario.mjs'

const remoteDevice = {
  device_id: 'app-record-73',
  app_device_id: 'wework-e2e-peer-app-430',
}
const remoteTask = {
  accepted: true,
  deviceId: 'app-record-73',
  taskId: 'remote-task',
  workspacePath: '/workspace/review',
}

test('accepts a remote creation receipt on the recorded canonical App route', () => {
  assert.doesNotThrow(() =>
    assertRemoteQuestionCreated(remoteTask, remoteDevice, remoteTask.workspacePath)
  )
})

test('validates the explicitly selected execution target before the device alias', () => {
  const device = {
    ...remoteDevice,
    device_id: remoteDevice.app_device_id,
    execution_target_id: remoteDevice.device_id,
  }
  assert.doesNotThrow(() =>
    assertRemoteQuestionCreated(remoteTask, device, remoteTask.workspacePath)
  )
})

test('rejects a receipt for the original App alias or another App', () => {
  for (const deviceId of [remoteDevice.app_device_id, 'app-record-74']) {
    assert.throws(
      () =>
        assertRemoteQuestionCreated(
          { ...remoteTask, deviceId },
          remoteDevice,
          remoteTask.workspacePath
        ),
      assert.AssertionError
    )
  }
})

test('keeps remote acceptance, task identity, and workspace evidence strict', () => {
  assert.throws(
    () =>
      assertRemoteQuestionCreated(
        { ...remoteTask, accepted: false, error: 'remote access denied' },
        remoteDevice,
        remoteTask.workspacePath
      ),
    /Remote interaction fixture was rejected: remote access denied/
  )
  assert.throws(
    () =>
      assertRemoteQuestionCreated(
        { ...remoteTask, taskId: '' },
        remoteDevice,
        remoteTask.workspacePath
      ),
    /The peer App did not return the created task identity/
  )
  assert.throws(
    () =>
      assertRemoteQuestionCreated(
        { ...remoteTask, workspacePath: '/workspace/another-review' },
        remoteDevice,
        remoteTask.workspacePath
      ),
    error =>
      error instanceof assert.AssertionError &&
      error.actual === '/workspace/another-review' &&
      error.expected === remoteTask.workspacePath
  )
})

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
