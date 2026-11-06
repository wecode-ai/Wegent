import assert from 'node:assert/strict'
import { waitForValue } from './workspace-agent-setup.mjs'

async function readNativeToolCallId(control, address, matches, label, timeoutMs) {
  return waitForValue(
    async () => {
      const messages = JSON.parse(
        await control.command('getRuntimeConversationMessages', 'body', {
          value: JSON.stringify(address),
        })
      )
      const found = []
      const observed = []
      const visit = blocks => {
        for (const block of blocks ?? []) {
          if (block.type === 'tool')
            observed.push({
              id: block.id,
              server: block.mcpServer,
              tool: block.toolName,
              inputKeys: Object.keys(block.toolInput ?? {}),
            })
          if (block.type === 'tool' && matches(block)) found.push(block)
          visit(block.children)
        }
      }
      for (const message of messages) visit(message.blocks)
      assert.ok(found.length <= 1, `Ambiguous native invocation: ${label}`)
      return { id: found[0]?.id, observed }
    },
    result => result.id,
    `Missing native invocation: ${label}`,
    timeoutMs
  )
}

export function readNativeMcpCallId(control, address, server, tool, timeoutMs) {
  return readNativeToolCallId(
    control,
    address,
    block => block.mcpServer === server && block.toolName === `${server}.${tool}`,
    `${server}.${tool}`,
    timeoutMs
  )
}

export function readNativeCommandCallId(control, address, marker, timeoutMs) {
  return readNativeToolCallId(
    control,
    address,
    block => JSON.stringify(block.toolInput ?? {}).includes(marker),
    `command containing ${marker}`,
    timeoutMs
  )
}
