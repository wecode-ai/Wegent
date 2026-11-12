import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertElicitationToolResult,
  currentTurnHasToolOutput,
  currentTurnHasToolSearchResult,
  lastUserMessageBody,
} from '../e2e/desktop/modules/runtime-input-answer-model.mjs'

const callId = 'input-answer-call'
const userMessage = { type: 'message', role: 'user', content: 'new prompt' }
const toolOutput = { type: 'function_call_output', call_id: callId, output: '{}' }

test('a native date-context update does not begin a new user turn', () => {
  const environment = {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: '<environment_context>\n  <current_date>2026-11-11</current_date>\n</environment_context>',
      },
    ],
  }
  const input = [
    userMessage,
    toolOutput,
    { type: 'tool_search_output', tools: [{ name: 'sites' }] },
    environment,
  ]
  assert.equal(currentTurnHasToolOutput({ input }, callId), true)
  assert.equal(currentTurnHasToolSearchResult({ input }, 'sites'), true)
  assert.equal(lastUserMessageBody({ input }), JSON.stringify(userMessage))
  assert.equal(lastUserMessageBody({ messages: input }), JSON.stringify(userMessage))
  assert.equal(
    currentTurnHasToolOutput(
      { input: [...input, { ...userMessage, content: 'actual next prompt' }] },
      callId
    ),
    false
  )
})

test('validates accepted and cancelled MCP continuations against their scenario', () => {
  const body = output => ({
    input: [
      userMessage,
      {
        ...toolOutput,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
          { type: 'input_text', text: JSON.stringify(output) },
        ],
      },
    ],
  })
  const accepted = body({ audience: 'owner', marker: 'E2E_MCP_ELICITATION_ACCEPTED:owner' })
  const cancelled = body({ action: 'cancel' })
  assertElicitationToolResult(accepted, callId, false)
  assertElicitationToolResult(cancelled, callId, true)
  assert.throws(() => assertElicitationToolResult(cancelled, callId, false))
  assert.throws(() => assertElicitationToolResult(accepted, callId, true))
  assert.throws(() => assertElicitationToolResult(body({ action: 'decline' }), callId, true))
})

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
