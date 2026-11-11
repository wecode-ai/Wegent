import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createHarnessPackage, confirmHarnessInstallation } from './harness-app-fixture.mjs'
import { fetchLocalRuntime } from './runtime-request.mjs'

const NEXT_VERSION = '0.1.1'

async function invoke(control, origin, capability, params = {}, expectedOk = true) {
  const response = await fetchLocalRuntime(control, `${origin}/wework/electron-host/v1/invoke`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  const payload = await response.json()
  assert.equal(response.ok, expectedOk, `${capability}: ${JSON.stringify(payload)}`)
  assert.equal(payload.ok, expectedOk, `${capability}: ${JSON.stringify(payload)}`)
  return expectedOk ? payload.result : payload.error
}

export async function verifyRunningSmartAppInstallRejected(
  control,
  { installationId, modelKey, resultDir }
) {
  const origin = await control.command('getLocationOrigin', 'body')
  const before = (await invoke(control, origin, 'smartApps.list')).find(
    item => item.id === installationId
  )
  assert.equal(before?.state, 'running', 'The native install guard fixture is not running')
  assert.ok(before.webUrl, 'The native install guard fixture has no running URL')
  assert.equal(before.modelKey, modelKey, 'The running fixture did not retain its chosen model')
  assert.notEqual(before.manifest.version, NEXT_VERSION)
  const archivePath = await createHarnessPackage(resultDir, installationId, '0.2.0-rc.2', {
    archiveName: `${installationId}-running-install-guard`,
    version: NEXT_VERSION,
  })
  const preview = await invoke(control, origin, 'smartApps.preview', { archivePath })
  assert.equal(preview.valid, true, 'The native install guard replacement archive is invalid')
  assert.equal(preview.manifest.name, installationId)
  assert.equal(preview.manifest.version, NEXT_VERSION)
  const params = { archivePath, expectedSha256: preview.sha256, modelKey: `${modelKey}-blocked` }
  const error = await invoke(control, origin, 'smartApps.install', params, false)
  assert.equal(error?.message, 'Stop the Smart app before installing a new version')
  const after = (await invoke(control, origin, 'smartApps.list')).find(
    item => item.id === installationId
  )
  assert.deepEqual(after, before, 'Rejected installation changed the running app or its model')
  return { origin, installationId, params: { ...params, modelKey }, before }
}

export async function verifyStoppedSmartAppInstallAllowed(control, fixture) {
  const { origin, installationId, params, before } = fixture
  const stopped = (await invoke(control, origin, 'smartApps.list')).find(
    item => item.id === installationId
  )
  assert.equal(stopped?.state, 'installed', 'The existing stop flow left the fixture running')
  assert.equal(stopped.webUrl, null)
  const installing = invoke(control, origin, 'smartApps.install', params)
  await confirmHarnessInstallation(control, 10_000)
  const installed = await installing
  assert.equal(installed.id, installationId)
  assert.equal(installed.state, 'installed')
  assert.equal(installed.webUrl, null)
  assert.equal(installed.modelKey, before.modelKey)
  assert.equal(installed.manifest.version, NEXT_VERSION)
  assert.deepEqual(
    (await invoke(control, origin, 'smartApps.list')).find(item => item.id === installationId),
    installed,
    'The successful stopped installation was not persisted by the native owner'
  )
  await rm(params.archivePath)
}
