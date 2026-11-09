import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const CANCELLATION_DEADLINE_MS = 5_000
const NATIVE_TIMEOUT_MS = 10_000

/** Cancel a real bounded native observation after the host reports it active. */
export async function verifyComputerUseCancellation(control, record, timeoutMs) {
  const request = (name, args, signal) =>
    fetch(`http://${record.address}/computer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'callTool', name, arguments: args }),
      signal,
    }).then(response => response.json())
  const discovered = await request(
    'list_windows',
    { pid: record.pid },
    AbortSignal.timeout(timeoutMs)
  )
  assert.equal(discovered.ok, true)
  assert.equal(discovered.data.isError, false)
  const { windows } = JSON.parse(discovered.data.structuredJson)
  const window = windows.find(
    candidate => candidate.pid === record.pid && candidate.bounds.height > 100
  )
  assert.ok(window, 'Cancellation requires the isolated host window')

  const controller = new AbortController()
  const startedAt = performance.now()
  const operation = request(
    'verify_state',
    {
      pid: record.pid,
      window_id: window.window_id,
      expect: [{ window: { exists: false } }],
      include_screenshot: false,
      timeout_ms: NATIVE_TIMEOUT_MS,
    },
    controller.signal
  ).then(
    value => ({ value }),
    error => ({ error })
  )
  try {
    await control.command('waitFor', '[data-testid="computer-use-activity-indicator"]', {
      text: 'verify_state',
      timeoutMs,
    })
    const cancelledAt = performance.now()
    controller.abort()
    const result = await operation
    assert.equal(result.error?.name, 'AbortError', 'The pending observation was not cancelled')
    // A local AbortError alone does not prove server cancellation. Bound the
    // complete observation below the SDK's 10-second natural timeout.
    const remainingMs = Math.min(
      CANCELLATION_DEADLINE_MS - (performance.now() - cancelledAt),
      NATIVE_TIMEOUT_MS - (performance.now() - startedAt)
    )
    assert.ok(remainingMs > 0, 'The native cancellation deadline expired before acknowledgement')
    await control.command('waitFor', '[data-testid="computer-use-activity-indicator"]', {
      visible: false,
      timeoutMs: Math.min(timeoutMs, remainingMs),
    })
    assert.ok(
      performance.now() - cancelledAt < CANCELLATION_DEADLINE_MS,
      'Native cancellation exceeded its acknowledgement deadline'
    )
    assert.ok(
      performance.now() - startedAt < NATIVE_TIMEOUT_MS,
      'The observation finished too late to distinguish cancellation from natural timeout'
    )
    const after = await request('list_windows', { pid: record.pid }, AbortSignal.timeout(timeoutMs))
    assert.equal(after.ok, true, 'The cancelled observation left action admission occupied')
    assert.equal(after.data.isError, false, 'Native observation did not recover after cancellation')
    assert.ok(
      JSON.parse(after.data.structuredJson).windows.some(
        candidate => candidate.window_id === window.window_id
      ),
      'The target window disappeared instead of its observation being cancelled'
    )
  } finally {
    controller.abort()
    await operation
  }
}
