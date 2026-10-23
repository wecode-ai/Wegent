import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentTurnHasToolOutput,
  currentTurnHasToolSearchResult,
} from '../e2e/desktop/modules/runtime-input-answer-model.mjs'

const callId = 'input-answer-call'
const userMessage = { type: 'message', role: 'user', content: 'new prompt' }
const toolOutput = { type: 'function_call_output', call_id: callId, output: '{}' }

test('ignores a tool output inherited from an earlier thread turn', () => {
  assert.equal(
    currentTurnHasToolOutput(
      {
        input: [
          { type: 'message', role: 'user', content: 'source prompt' },
          toolOutput,
          { type: 'message', role: 'assistant', content: 'source completion' },
          userMessage,
        ],
      },
      callId
    ),
    false
  )
})

test('detects the tool output that continues the current turn', () => {
  assert.equal(currentTurnHasToolOutput({ input: [userMessage, toolOutput] }, callId), true)
})

test('ignores tool outputs for other calls and requests without tool output', () => {
  assert.equal(
    currentTurnHasToolOutput(
      { input: [userMessage, { ...toolOutput, call_id: 'another-call' }] },
      callId
    ),
    false
  )
  assert.equal(currentTurnHasToolOutput({ input: [userMessage] }, callId), false)
  assert.equal(currentTurnHasToolOutput({}, callId), false)
})

test('scopes tool search results to the current turn', () => {
  const namespace = 'wegent_sites_interactions'
  const historicalSearch = { type: 'tool_search_output', tools: [{ name: namespace }] }
  const currentSearch = { type: 'tool_search_output', tools: [{ name: namespace }] }
  assert.equal(
    currentTurnHasToolSearchResult({ input: [historicalSearch, userMessage] }, namespace),
    false
  )
  assert.equal(
    currentTurnHasToolSearchResult(
      { input: [historicalSearch, userMessage, currentSearch] },
      namespace
    ),
    true
  )
})
