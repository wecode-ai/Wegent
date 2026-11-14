import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeSubagentCompletionPayload } from '../e2e/desktop/modules/subagent-request.mjs'

const sender = '/root/worker'
const text =
  'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nVerified worker result'
const message = (value = text) => ({
  type: 'agent_message',
  author: sender,
  recipient: '/root',
  content: [{ type: 'input_text', text: value }],
})

test('reads the current native V2 completion envelope for the actual spawned task', () => {
  assert.equal(
    nativeSubagentCompletionPayload({ input: [message()] }, sender),
    'Verified worker result'
  )
})

test('never mistakes user input, a tool prompt or another worker for completion', () => {
  for (const input of [
    [{ role: 'user', content: text }],
    [{ role: 'assistant', content: text }],
    [{ ...message(), author: '/root/other' }],
    [{ ...message(), recipient: '/another' }],
    [{ type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ message: text }) }],
    [message(text.replace('Sender: /root/worker', 'Sender: /root/other'))],
    [message(text.replace('Task name: /root', 'Task name: /another'))],
  ])
    assert.equal(nativeSubagentCompletionPayload({ input }, sender), undefined)
})

test('retains failed and empty completion payloads so fixture assertions reject them', () => {
  const prefix = text.slice(0, text.indexOf('Verified worker result'))
  assert.equal(nativeSubagentCompletionPayload({ input: [message(prefix)] }, sender), '')
  assert.equal(
    nativeSubagentCompletionPayload({ input: [message(prefix + 'Agent errored: denied')] }, sender),
    'Agent errored: denied'
  )
})
