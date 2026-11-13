import assert from 'node:assert/strict'
import { nativeCloudAuthorizationFixture } from './native-cloud-authorization-client.mjs'
import { verifyPositiveMcpCloudOwnership } from './mcp-app-cloud-positive.mjs'
import { fetchLocalRuntime } from './runtime-request.mjs'

/** Exercise native ownership through the real Backend and remote executor. */
export async function verifyNativeMcpCloudRouting(control, cloudEnvironment, userDataDirectory) {
  const authorization = nativeCloudAuthorizationFixture(
    cloudEnvironment,
    userDataDirectory,
    control
  )
  try {
    await authorization.authorize()
    const origin = await control.command('getLocationOrigin', 'body')
    const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
      .currentRuntimeTask
    assert.ok(address?.taskId)
    const sessionId = crypto.randomUUID()
    const invoke = (capability, params) =>
      fetchLocalRuntime(control, `${origin}/wework/electron-host/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, params }),
      }).then(response => response.json())
    const result = await invoke('mcpApps.retainSession', {
      address,
      callId: 'missing-native-cloud-app-source',
      sessionId,
      windowLabel: 'main',
      target: {
        apiBaseUrl: `${cloudEnvironment.backendUrl}/api`,
        socketBaseUrl: cloudEnvironment.backendUrl,
        socketPath: '/socket.io',
      },
    })
    assert.equal(result.ok, false)
    assert.match(
      result.error.message,
      /Source invocation does not belong to this task/,
      'Native ownership must reach the remote task and preserve source authority'
    )
    const sessions = await invoke('e2e.mcpAppFrame', {
      url: 'https://unused.example',
      action: 'sessions',
    })
    assert.equal(sessions.ok, true)
    assert.equal(
      sessions.result.includes(sessionId),
      false,
      'Rejected remote acquisition must release its native owner'
    )
    await verifyPositiveMcpCloudOwnership(control, cloudEnvironment, address, invoke)
  } finally {
    await authorization.restore()
  }
}
