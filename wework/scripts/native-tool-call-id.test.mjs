// @vitest-environment node
import { expect, test } from 'vitest'
import {
  readNativeMcpCallId,
  readNativeCommandCallId,
} from '../e2e/desktop/modules/native-tool-call-id.mjs'

const address = { taskId: 'isolated-task', deviceId: 'local-device' }
const block = {
  id: 'exec-native-mcp-id',
  parentToolUseId: 'model-outer-exec-id',
  type: 'tool',
  mcpServer: 'counter',
  toolName: 'counter.show_app',
}
const control = blocks => ({
  command: async (name, selector, options) => {
    expect(name).toBe('getRuntimeConversationMessages')
    expect(selector).toBe('body')
    expect(JSON.parse(options.value)).toEqual(address)
    return JSON.stringify([{ blocks }])
  },
})

test('binds app operations to the real native MCP call instead of its outer exec', async () => {
  expect(
    await readNativeMcpCallId(
      control([block, { ...block, id: 'foreign', mcpServer: 'other' }]),
      address,
      'counter',
      'show_app',
      1000
    )
  ).toBe('exec-native-mcp-id')
})

test('rejects ambiguous native MCP invocations', async () => {
  await expect(
    readNativeMcpCallId(
      control([block, { ...block, id: 'duplicate' }]),
      address,
      'counter',
      'show_app',
      1000
    )
  ).rejects.toThrow('Ambiguous')
})

test('correlates native command identity by its actual command input', async () => {
  const blocks = [
    { id: 'earlier-native-id', type: 'tool', toolInput: { cmd: 'printf earlier-created-tool' } },
    { id: 'later-native-id', type: 'tool', toolInput: { command: 'printf later-created-tool' } },
  ]
  expect(
    await readNativeCommandCallId(control(blocks), address, 'earlier-created-tool', 1000)
  ).toBe('earlier-native-id')
  expect(await readNativeCommandCallId(control(blocks), address, 'later-created-tool', 1000)).toBe(
    'later-native-id'
  )
})
