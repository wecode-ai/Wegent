import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'

test('IM question protocol coverage runs in the existing cloud CI checkpoint', () => {
  const catalog = loadDesktopCheckpointCatalog()
  for (const path of [
    'wework/e2e/desktop/modules/runtime-im-questions.mjs',
    'wework/e2e/desktop/modules/runtime-im-question-understanding.mjs',
    'backend/app/services/im/question_context.py',
    'executor/src/task_runtime/mcp/stand_in_questions.rs',
    'backend/tests/e2e/runtime_question_reply_fixture.py',
    'backend-rs/src/socketio/device_runtime_questions.rs',
    'backend/app/services/im/runtime_questions.py',
  ]) {
    assert.deepEqual(catalog.PATH_TARGETS.get(path), ['cloud:cloud-model-recovery'])
  }
  assert.ok(catalog.ci.cloud_segments.includes('cloud-model-recovery'))
})
