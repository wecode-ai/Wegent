import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'vitest'
import { pluginApi, until } from '../e2e/desktop/modules/plugin-regression-fixture.mjs'
import { hasLateInstallCorrection } from '../e2e/desktop/modules/plugin-write-coordination.mjs'

test('cancels a held sync request without cancelling later recovery requests', async t => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url })
    request.resume()
    if (request.method === 'POST') return
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ items: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const cloud = { backendUrl: `http://127.0.0.1:${server.address().port}`, authToken: 'fixture' }
  const controller = new AbortController()
  const pending = pluginApi(cloud, '/plugins/installed/1/sync-device', 'POST', {
    signal: controller.signal,
  })
  const cancelled = assert.rejects(pending, { name: 'AbortError' })
  await until(
    () => requests.length,
    count => count === 1,
    'The real HTTP server did not receive the held sync',
    2000
  )
  controller.abort()
  await cancelled

  assert.deepEqual(await pluginApi(cloud, '/plugins/installed'), { items: [] })
  assert.deepEqual(requests, [
    { method: 'POST', path: '/api/plugins/installed/1/sync-device' },
    { method: 'GET', path: '/api/plugins/installed' },
  ])
})

const deviceId = 'wework-e2e-cloud-device'
// Keep the backend's real timestamp, level and request-ID field order.
const prefix = '2026-10-23 12:06:59 INFO [02701fbc] /repo/backend/app'
const correctionLog = [
  `${prefix}/main.py:800 : request : POST /api/plugins/installed/72/sync-device device_id=${deviceId} 02701fbc 127.0.0.1 [admin]`,
  `${prefix}/services/device/capability_sync_service.py:648 : Capability sync delivered: user_id=1 device_id=${deviceId} skills=0 plugins=1 mcps=0`,
  `${prefix.replace('INFO', 'WARNING')}/services/device/capability_sync_service.py:330 : Capability desired state changed during sync; retrying latest snapshot: user_id=1 device_id=${deviceId} attempt=1`,
  `${prefix}/services/device/capability_sync_service.py:555 : Sending capability sync: user_id=1 logical_device_id=${deviceId} runtime_device_id=${deviceId} socket_id=socket mode=merge skill_names=[] plugin_names=[] mcp_names=[]`,
]

test('observes the request-scoped late install ACK before its removal retry', () => {
  assert.equal(hasLateInstallCorrection(correctionLog.join('\n'), 72, deviceId), true)
  assert.equal(hasLateInstallCorrection(correctionLog.join('\n'), 73, deviceId), false)
  assert.equal(hasLateInstallCorrection(correctionLog.join('\n'), 72, 'other-device'), false)
})

test.each([1, 2])('rejects correction stage %i from an unrelated request', stage => {
  const lines = correctionLog.map((line, index) =>
    index === stage ? line.replace('[02701fbc]', '[background]') : line
  )
  assert.equal(hasLateInstallCorrection(lines.join('\n'), 72, deviceId), false)
})

test('allows the removal worker to own the coalesced corrective dispatch', () => {
  const lines = correctionLog.map((line, index) =>
    index === 3 ? line.replace('[02701fbc]', '[background]') : line
  )
  assert.equal(hasLateInstallCorrection(lines.join('\n'), 72, deviceId), true)
})

test('rejects a desired-state retry that preceded the acknowledged install', () => {
  const [request, ack, retry, dispatch] = correctionLog
  assert.equal(
    hasLateInstallCorrection([request, retry, ack, dispatch].join('\n'), 72, deviceId),
    false
  )
})
