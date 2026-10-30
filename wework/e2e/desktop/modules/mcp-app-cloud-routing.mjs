import assert from 'node:assert/strict'
import { fetchLocalRuntime } from './runtime-request.mjs'

/** Exercise native ownership through the real Backend and remote executor. */
export async function verifyNativeMcpCloudRouting(control, cloudEnvironment, userDataDirectory) {
  const { CloudCredentialService } =
    await import('../../../electron/dist/host/cloud-credential-service.js')
  const credentials = new CloudCredentialService(userDataDirectory, fetch)
  const apiBaseUrl = `${cloudEnvironment.backendUrl}/api`
  const created = await fetch(`${apiBaseUrl}/auth/wework/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_public_key: await credentials.devicePublicKey() }),
  })
  assert.equal(created.ok, true, 'The real Backend must create the native authorization session')
  const authorization = await created.json()
  const approved = await fetch(
    `${apiBaseUrl}/auth/wework/sessions/${authorization.session_id}/approve`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudEnvironment.authToken}` },
    }
  )
  assert.equal(approved.ok, true, 'The fixture user must approve the native session')
  const claimed = await credentials.claimAuthorization({
    apiBaseUrl,
    sessionId: authorization.session_id,
    pollToken: authorization.poll_token,
  })
  assert.equal(claimed.status, 'success')
  assert.equal(claimed.credentialMode, 'desktop_refresh')
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
}
