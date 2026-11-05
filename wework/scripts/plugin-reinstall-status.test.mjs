// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { assertReinstallResponse } from '../e2e/desktop/modules/plugin-reinstall-status.mjs'

const slug = 'coordination-e2e-reinstall-status'
const deviceId = 'requesting-device'

function installedReply(sync = null) {
  return {
    sync,
    plugin: {
      spec: { source: { pluginKey: slug }, releaseId: 3 },
      status: {
        devices: [
          {
            deviceId,
            state: 'installed',
            actualReleaseId: 3,
            desiredReleaseId: 3,
            errorCode: null,
          },
        ],
      },
    },
  }
}

test.each([null, { success: true }])(
  'accepts a confirmed reinstall with receipt %j, including a concurrent no-op',
  sync => {
    assert.doesNotThrow(() => assertReinstallResponse(installedReply(sync), slug, deviceId))
  }
)

test('rejects an explicit sync failure even when an old device row looks installed', () => {
  assert.throws(
    () => assertReinstallResponse(installedReply({ success: false }), slug, deviceId),
    /sync failure/
  )
})

test.each([
  ['missing device', plugin => (plugin.status.devices = [])],
  ['other device', plugin => (plugin.status.devices[0].deviceId = 'other-device')],
  ['pending install', plugin => (plugin.status.devices[0].state = 'pending')],
  ['stale actual release', plugin => (plugin.status.devices[0].actualReleaseId = 2)],
  ['stale desired release', plugin => (plugin.status.devices[0].desiredReleaseId = 2)],
  ['missing release', plugin => (plugin.spec.releaseId = null)],
  ['wrong plugin', plugin => (plugin.spec.source.pluginKey = 'other-plugin')],
  ['device error', plugin => (plugin.status.devices[0].errorCode = 'sync_failed')],
])('rejects a no-op response with %s', (_name, invalidate) => {
  const reply = installedReply()
  invalidate(reply.plugin)
  assert.throws(() => assertReinstallResponse(reply, slug, deviceId))
})
