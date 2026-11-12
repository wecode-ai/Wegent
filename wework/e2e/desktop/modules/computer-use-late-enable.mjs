import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { initialize, startNativeClient } from './native-mcp-environment.mjs'

/** Keep one real Codex process alive across the host bridge's enable and recovery. */
export async function startComputerUseLateEnable({
  codexBinary,
  executorBinary,
  environment,
  executorHome,
  resultDir,
  workspacePath,
}) {
  const root = join(resultDir, 'computer-use-late-enable')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key) && value != null
    )
  )
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home })
  assert.equal(env.WEWORK_COMPUTER_USE_BRIDGE_URL, undefined)
  assert.equal(env.WEWORK_COMPUTER_USE_BRIDGE_TOKEN, undefined)
  const client = startNativeClient({
    binary: codexBinary,
    args: ['app-server'],
    cwd: workspacePath,
    env,
    root,
    phase: 'late-enable',
  })
  try {
    await initialize(client)
  } catch (error) {
    await client.close()
    throw error
  }
  const pid = client.child.pid
  let threadId
  let successfulCalls = 0
  let disabledVerified = false
  return {
    async verify() {
      assert.equal(client.child.exitCode, null, 'The original Codex process exited')
      if (!threadId) {
        const started = await client.call('thread/start', {
          cwd: workspacePath,
          ephemeral: true,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          config: {
            'mcp_servers.wework_computer.command': executorBinary,
            'mcp_servers.wework_computer.args': [
              'computer-use-mcp-server',
              join(executorHome, 'runtime', 'computer-use-bridge.json'),
            ],
            'mcp_servers.wework_computer.startup_timeout_sec': 15,
            'mcp_servers.wework_computer.default_tools_approval_mode': 'writes',
          },
        })
        threadId = started.thread.id
      }
      const status = await client.call('mcpServerStatus/list', {
        threadId,
        serverName: 'wework_computer',
        limit: 100,
      })
      const computer = status.data.find(server => server.name === 'wework_computer')
      assert.ok(computer, 'Late-enabled computer MCP was not registered')
      assert.ok(
        Object.values(computer.tools).some(tool => tool.name === 'list_apps'),
        'The real bridge did not publish native tools to the existing Codex process'
      )
      assert.equal(client.child.pid, pid, 'Enabling computer use replaced the Codex process')
      const result = await client.call('mcpServer/tool/call', {
        threadId,
        server: 'wework_computer',
        tool: 'list_apps',
        arguments: {},
      })
      assert.notEqual(result.isError, true, 'The real desktop read operation failed')
      assert.ok(result.content.length > 0, 'The real desktop operation returned no content')
      successfulCalls += 1
    },
    async verifyDisabled() {
      assert.ok(threadId, 'Disable verification requires the original computer tool session')
      await assert.rejects(
        client.call('mcpServer/tool/call', {
          threadId,
          server: 'wework_computer',
          tool: 'list_apps',
          arguments: {},
        }),
        /Computer use bridge record is unavailable/,
        'Disabling computer use did not revoke the existing MCP session'
      )
      disabledVerified = true
    },
    diagnostics: () => ({ processId: pid, successfulCalls, disabledVerified }),
    async close() {
      try {
        if (threadId) await client.call('thread/unsubscribe', { threadId })
      } finally {
        await client.close()
      }
    },
  }
}
