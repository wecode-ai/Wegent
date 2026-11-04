import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { nativeCloudCredentialSnapshot } from './native-cloud-credential-snapshot.mjs'

// Run with the packaged Electron Node runtime so CI needs no loose host build.
const { CloudCredentialService } = await import(
  pathToFileURL(`${process.resourcesPath}/app.asar/dist/host/cloud-credential-service.js`).href
)
let input = ''
for await (const chunk of process.stdin) input += chunk
const { apiBaseUrl, authToken, userDataDirectory, snapshotId, clear } = JSON.parse(input)
const credentials = new CloudCredentialService(userDataDirectory, fetch)
const snapshot = nativeCloudCredentialSnapshot(userDataDirectory, snapshotId)
if (clear) {
  await snapshot.restore()
  process.stdout.write('cleared')
  process.exit(0)
}
await snapshot.capture()
const created = await fetch(`${apiBaseUrl}/auth/wework/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ device_public_key: await credentials.devicePublicKey() }),
})
assert.equal(created.ok, true, 'The real Backend must create the native authorization session')
const authorization = await created.json()
const approved = await fetch(
  `${apiBaseUrl}/auth/wework/sessions/${authorization.session_id}/approve`,
  { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } }
)
assert.equal(approved.ok, true, 'The fixture user must approve the native session')
const claimed = await credentials.claimAuthorization({
  apiBaseUrl,
  sessionId: authorization.session_id,
  pollToken: authorization.poll_token,
})
assert.equal(claimed.status, 'success')
assert.equal(claimed.credentialMode, 'desktop_refresh')
process.stdout.write('authorized')
