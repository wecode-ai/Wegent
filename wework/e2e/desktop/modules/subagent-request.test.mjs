import assert from 'node:assert/strict'
import test from 'node:test'

import { isCollaborationSubagentRequest } from './subagent-request.mjs'

test('matches only collaboration thread-spawn requests', () => {
  assert.equal(isCollaborationSubagentRequest({ 'x-openai-subagent': 'collab_spawn' }), true)
  assert.equal(isCollaborationSubagentRequest({ 'x-openai-subagent': 'compact' }), false)
  assert.equal(isCollaborationSubagentRequest({ 'x-openai-subagent': 'review' }), false)
  assert.equal(isCollaborationSubagentRequest({}), false)
})
