// @vitest-environment node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'vitest'
import {
  assertReinstallResponse,
  holdReinstallResponse,
} from '../e2e/desktop/modules/plugin-reinstall-status.mjs'
import { TransportFaultProxy } from '../e2e/desktop/modules/transport-fault-proxy.mjs'
import { until } from '../e2e/desktop/modules/plugin-regression-fixture.mjs'

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

test('validates a held real HTTP response against its wire route instead of a device-list alias', async t => {
  const routeId = 'app-record-73'
  const reply = installedReply()
  reply.plugin.status.devices[0].deviceId = routeId
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(reply))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const proxy = await new TransportFaultProxy(`http://127.0.0.1:${server.address().port}`).start()
  t.onTestFinished(async () => {
    await proxy.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const path = '/api/plugins/marketplace/2/install'
  const assertHeld = holdReinstallResponse(proxy, path)
  const request = fetch(`${proxy.url}${path}?device_id=${routeId}`, { method: 'POST' })
  const held = await until(
    () => proxy.requests.find(entry => entry.committedResponseHeld),
    entry => Boolean(entry),
    'The real proxy did not hold the install response',
    2000
  )
  assert.doesNotThrow(() => assertHeld(held, slug))
  assert.throws(() => assertReinstallResponse(reply, slug, 'backend-device-list-id'))
  assert.equal(Object.hasOwn(held, 'deviceId'), false, 'Route queries must not enter evidence')
  await held.release()
  assert.equal((await request).status, 200)
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
