import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLocalRuntimeJson } from '../modules/runtime-request.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'

export async function verifyMcpDiscoveryNetworkFailure(control, userDataDirectory, timeoutMs) {
  const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
    .currentRuntimeTask
  const origin = await control.command('getLocationOrigin', 'body')
  const configureFault = async enabled => {
    const result = await fetchLocalRuntimeJson(
      control,
      `${origin}/wework/electron-host/v1/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'e2e.mcpAppDiscoveryFault', params: { enabled } }),
      }
    )
    assert.equal(result.ok, true)
    return result.result
  }
  const reopen = async () => {
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('navigate', 'body', {
      value: `/runtime-tasks?${new URLSearchParams({ deviceId: address.deviceId, taskId: address.taskId })}`,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: 'ORDINARY_MCP_COMPLETE',
    })
  }
  await configureFault(true)
  try {
    await reopen()
    const deadline = Date.now() + timeoutMs
    let canceled = 0
    while (Date.now() < deadline) {
      canceled = (await configureFault(true)).canceled
      if (canceled > 0) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(canceled > 0, 'The real Chromium discovery request must fail')
    assert.equal(Number(await control.command('getElementCount', '[data-testid="mcp-app"]')), 0)
    const logPath = join(userDataDirectory, 'logs', 'executor-transport.log')
    let diagnostics = ''
    while (Date.now() < deadline) {
      diagnostics = await readFile(logPath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      if (
        diagnostics.includes('mcp_app_discovery_failed') &&
        diagnostics.includes('ERR_BLOCKED_BY_CLIENT')
      )
        break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.match(diagnostics, /"stage":"fetch_failed"/)
    assert.match(diagnostics, /"stage":"mcp_app_discovery_failed"/)
    assert.match(diagnostics, /ERR_BLOCKED_BY_CLIENT/)
  } finally {
    await configureFault(false)
  }
  await reopen()
  assert.equal(
    await requestExecutor(
      control,
      'runtime.mcp_apps.request',
      {
        address,
        callId: 'ordinary-mcp-read',
        method: 'discover',
      },
      timeoutMs
    ),
    null
  )
  assert.equal(Number(await control.command('getElementCount', '[data-testid="mcp-app"]')), 0)
}
