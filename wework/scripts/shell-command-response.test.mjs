import { expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { accountCommandResult } from '../e2e/desktop/modules/account-auth-command.mjs'
import {
  requestAdvertisesShellCommand,
  nodeScriptCommand,
  shellCommandPollResponse,
  shellCommandResponse,
} from '../e2e/desktop/modules/shell-command-response.mjs'

const programmaticRequest = {
  input: [
    {
      type: 'additional_tools',
      tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }],
    },
  ],
}

test('executes Node scripts with quotes, Unicode and shell metacharacters intact', () => {
  const payload = '阶段验收 \' " \\ $() ` \n'
  const command = nodeScriptCommand(`process.stdout.write(${JSON.stringify(payload)})`)
  const windows = process.platform === 'win32'
  const output = execFileSync(
    windows ? 'powershell.exe' : '/bin/sh',
    windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
    { encoding: 'utf8' }
  )
  expect(output).toBe(payload)
})

test('recognizes shell commands advertised through programmatic exec without top-level tools', () => {
  expect(requestAdvertisesShellCommand(programmaticRequest)).toBe(true)
  expect(requestAdvertisesShellCommand({ tools: [{ name: 'exec_command' }] })).toBe(true)
  expect(requestAdvertisesShellCommand({ input: [] })).toBe(false)
})

test('executes and polls the native shell through programmatic exec without completing early', async () => {
  const tools = {
    exec_command: vi.fn().mockResolvedValue({ session_id: 123, output: 'partial' }),
    write_stdin: vi.fn().mockResolvedValue({ exit_code: 0, output: 'PLUGIN_RECOVERY_OK' }),
  }
  const outputs = []
  const run = async event => {
    const text = []
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    await new AsyncFunction('tools', 'text', event.item.input)(tools, value =>
      text.push({ type: 'text', text: value })
    )
    outputs.push({
      type: 'custom_tool_call_output',
      call_id: event.item.call_id,
      output: text,
    })
  }
  const [command] = shellCommandResponse(programmaticRequest, 'business', 'sh business.sh', '/work')
  expect(command.item.type).toBe('custom_tool_call')
  await run(command)
  expect(tools.exec_command).toHaveBeenCalledWith({
    cmd: 'sh business.sh',
    workdir: '/work',
    yield_time_ms: 1000,
  })
  const pending = accountCommandResult(outputs, 'business')
  expect(pending).toEqual({ sessionId: 123, pollId: 'business-poll-1' })
  const [poll] = shellCommandPollResponse(programmaticRequest, pending.pollId, pending.sessionId)
  await run(poll)
  expect(tools.write_stdin).toHaveBeenCalledWith({
    session_id: 123,
    chars: '',
    yield_time_ms: 1000,
  })
  expect(accountCommandResult(outputs, 'business')).toEqual({
    output: expect.stringContaining('PLUGIN_RECOVERY_OK'),
  })
})

test('preserves direct shell and stdin tool calls', () => {
  const request = { tools: [{ name: 'exec_command' }, { name: 'write_stdin' }] }
  const command = shellCommandResponse(request, 'business', 'pwd', '/work').at(-1)
  expect(command.item).toMatchObject({ type: 'function_call', name: 'exec_command' })
  expect(JSON.parse(command.item.arguments)).toEqual({
    cmd: 'pwd',
    workdir: '/work',
    yield_time_ms: 1000,
  })
  const poll = shellCommandPollResponse(request, 'business-poll-1', 123).at(-1)
  expect(poll.item).toMatchObject({ type: 'function_call', name: 'write_stdin' })
})
