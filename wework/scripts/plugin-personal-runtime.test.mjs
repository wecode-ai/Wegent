import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  restorePersonalPluginRuntime,
  switchPersonalPluginAccount,
} from '../e2e/desktop/modules/plugin-personal-uninstall-flow.mjs'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('same-account recovery waits for both real connection surfaces without reloading', async () => {
  vi.useFakeTimers()
  let status = { backend: { configured: true, connected: false }, rendererConnected: false }
  const command = vi.fn(async action => {
    if (action === 'reconnectLocalExecutorCloud') return ''
    assert.equal(action, 'getPluginSyncDiagnostics')
    return JSON.stringify(status)
  })
  let finished = false
  const restoring = restorePersonalPluginRuntime({ command }, 'existing-device').then(() => {
    finished = true
  })
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(finished, false)
  status.backend.connected = true
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(finished, false, 'Native connection alone must not imply renderer recovery')
  status = { backend: { configured: false, connected: true }, rendererConnected: true }
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(finished, false, 'A missing Native profile must not count as recovery')
  status.backend.configured = true
  await vi.advanceTimersByTimeAsync(100)
  await restoring
  assert.equal(finished, true)
  assert.deepEqual(command.mock.calls[0], ['reconnectLocalExecutorCloud', 'body'])
  for (const args of command.mock.calls.slice(1))
    assert.deepEqual(args, ['getPluginSyncDiagnostics', 'body', { value: 'existing-device' }])
})

test('same-account recovery propagates the connection failure without reloading or retrying', async () => {
  const failure = new Error('Runtime token issuing failed')
  const command = vi.fn().mockRejectedValue(failure)
  await assert.rejects(
    restorePersonalPluginRuntime({ command }, 'existing-device'),
    error => error === failure
  )
  assert.equal(command.mock.calls.length, 1)
})

test('account switching reloads once, verifies the new identity and keeps the device', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 42 }) }))
  const control = {
    readyCount: 7,
    awaitReadyAfter: vi.fn().mockResolvedValue(undefined),
    command: vi.fn(async action => {
      if (action === 'getLocalExecutorStatus')
        return JSON.stringify({ ready: true, deviceId: 'existing-device' })
      if (action === 'disconnectLocalExecutorCloud')
        return JSON.stringify({ configured: false, connected: false })
      if (action === 'getPluginSyncDiagnostics')
        return JSON.stringify({
          backend: { configured: true, connected: true },
          rendererConnected: true,
        })
      if (action === 'getLocalStorageItem') return JSON.stringify({ user: { id: 42 } })
      assert.ok(['setCloudSessionToken', 'reloadMainWindow', 'waitFor'].includes(action))
      return ''
    }),
  }
  const result = await switchPersonalPluginAccount(control, {
    backendUrl: 'https://cloud.example',
    authToken: 'selected-account-token',
  })
  assert.equal(result.userId, 42)
  assert.equal(result.deviceId, 'existing-device')
  assert.deepEqual(control.awaitReadyAfter.mock.calls, [[7]])
  const actions = control.command.mock.calls.map(([action]) => action)
  assert.deepEqual(actions, [
    'getLocalExecutorStatus',
    'disconnectLocalExecutorCloud',
    'setCloudSessionToken',
    'reloadMainWindow',
    'waitFor',
    'getPluginSyncDiagnostics',
    'getLocalStorageItem',
    'getLocalExecutorStatus',
  ])
})
