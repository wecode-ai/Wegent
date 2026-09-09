import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountCommandResult } from '../e2e/desktop/modules/account-auth-command.mjs'

const output = (call_id, value) => ({ type: 'function_call_output', call_id, output: value })

test('a yielded command remains pending through repeated polls until terminal output', () => {
  const input = [output('business', 'Process running with session ID 95134\nOutput:\n')]
  assert.deepEqual(accountCommandResult(input, 'business'), {
    sessionId: 95134,
    pollId: 'business-poll-1',
  })
  input.push(output('business-poll-1', 'Process running with session ID 95134\nOutput:\npartial'))
  assert.deepEqual(accountCommandResult(input, 'business'), {
    sessionId: 95134,
    pollId: 'business-poll-2',
  })
  input.push(output('business-poll-2', 'Process exited with code 0\nOutput:\ncompleted'))
  const result = accountCommandResult(input, 'business')
  assert.equal(result.sessionId, undefined)
  assert.match(result.output, /partial[\s\S]*completed/)
})

test('unrelated outputs cannot complete the current command', () => {
  assert.equal(accountCommandResult([output('other', 'completed')], 'business'), null)
  assert.equal(accountCommandResult([], 'business'), null)
  assert.deepEqual(
    accountCommandResult([output('business', 'Process exited with code 1')], 'business'),
    {
      output: 'Process exited with code 1',
    }
  )
})
