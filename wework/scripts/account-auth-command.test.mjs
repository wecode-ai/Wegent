import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountCommandResult } from '../e2e/desktop/modules/account-auth-command.mjs'
import {
  shellCommandResponse,
  shellCommandPollResponse,
} from '../e2e/desktop/modules/shell-command-response.mjs'

test('programmatic shell calls preserve arguments and poll yielded commands', async () => {
  const request = {
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] },
        ],
      },
    ],
  }
  const command = "sh '/a path/plugin.sh'"
  const [event] = shellCommandResponse(request, 'business', command, '/workspace')
  assert.equal(event.item.type, 'custom_tool_call')
  assert.equal(event.item.namespace, 'functions')
  assert.equal(event.item.call_id, 'business')
  const captured = []
  const run = new Function('tools', 'text', `return (async () => { ${event.item.input} })()`)
  await run(
    {
      exec_command: async args => {
        assert.deepEqual(args, { cmd: command, workdir: '/workspace', yield_time_ms: 1000 })
        return { session_id: 123, output: '' }
      },
    },
    value => captured.push(value)
  )
  const pending = accountCommandResult(
    [{ type: 'custom_tool_call_output', call_id: 'business', output: captured[0] }],
    'business'
  )
  const [poll] = shellCommandPollResponse(request, pending.pollId, pending.sessionId)
  const pollRun = new Function('tools', 'text', `return (async () => { ${poll.item.input} })()`)
  await pollRun(
    {
      write_stdin: async args => {
        assert.equal(args.session_id, 123)
        return { exit_code: 0, output: 'PLUGIN_RECOVERY_OK' }
      },
    },
    value => captured.push(value)
  )
  assert.deepEqual(
    accountCommandResult(
      [{ type: 'custom_tool_call_output', call_id: pending.pollId, output: captured.at(-1) }],
      'business'
    ),
    { output: 'PLUGIN_RECOVERY_OK' }
  )
})

test('native commands keep their protocol and unsupported requests fail', () => {
  for (const name of ['exec_command', 'shell_command']) {
    const events = shellCommandResponse({ tools: [{ name }] }, 'business', 'pwd', '/workspace')
    const item = events.find(event => event.type === 'response.output_item.done').item
    assert.equal(item.name, name)
    assert.equal(JSON.parse(item.arguments).workdir, '/workspace')
  }
  assert.throws(() => shellCommandResponse({}, 'business', 'pwd'), /supported shell tool/)
})

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
