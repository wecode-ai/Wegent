import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

/** Cloud transport failure must not prevent local account isolation checks. */
export async function verifyStandInOfflineOwnership(control, userId, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const backend = await rpc('executor.backend.status', {})
  try {
    await rpc('executor.backend.configure', {
      backend_url: 'http://127.0.0.1:1',
      socket_url: 'http://127.0.0.1:1',
      auth_token: 'offline-protocol-fixture',
      device_type: 'app',
    })
    const offline = await rpc('executor.backend.status', {})
    assert.equal(offline.configured, true)
    assert.equal(offline.backend_url, 'http://127.0.0.1:1')
    const status = await rpc('runtime.coordination.status', { contextId: `personal:${userId}` })
    assert.ok(status && typeof status === 'object')
    await assert.rejects(
      rpc('runtime.coordination.status', { contextId: `personal:${userId + 1}` }),
      /requested owner must match the local workbench account/
    )
  } finally {
    await control.command('reconnectLocalExecutorCloud', 'body')
    const restored = await rpc('executor.backend.status', {})
    assert.equal(restored.configured, backend.configured)
    assert.equal(restored.backend_url, backend.backend_url)
    assert.equal(restored.socket_url, backend.socket_url)
  }
}
