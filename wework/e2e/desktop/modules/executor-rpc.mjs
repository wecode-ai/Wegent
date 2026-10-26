import { fetchLocalRuntime } from './runtime-request.mjs'
import assert from 'node:assert/strict'

export async function requestExecutor(control, method, params, timeoutMs) {
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id: `desktop-e2e-${method}`, method, params }),
    timeoutMs: timeoutMs,
  })
  const payload = await response.json()
  assert.equal(
    response.ok,
    true,
    `${method} returned HTTP ${response.status}: ${payload.error?.message}`
  )
  assert.equal(payload.ok, true, `${method} failed: ${payload.error?.message}`)
  return payload.result
}
