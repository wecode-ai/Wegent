import { fetchLocalRuntime } from './runtime-request.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function requestExecutor(control, method, params, timeoutMs) {
  const origin = await control.command('getLocationOrigin', 'body')
  const requestId = `desktop-e2e-${method}-${randomUUID()}`
  const startedAt = Date.now()
  let stage = 'response-headers'
  let response
  let payload
  try {
    response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ id: requestId, method, params }),
      timeoutMs,
    })
    stage = 'response-body'
    payload = await response.json()
  } catch (cause) {
    console.error('[desktop-e2e] Executor RPC HTTP failure', {
      requestId,
      method,
      stage,
      elapsedMs: Date.now() - startedAt,
      status: response?.status,
      contentLength: response?.headers.get('content-length'),
      contentEncoding: response?.headers.get('content-encoding'),
    })
    throw new Error(`${method} failed during ${stage} (${requestId})`, { cause })
  }
  assert.equal(
    response.ok,
    true,
    `${method} returned HTTP ${response.status}: ${payload.error?.message}`
  )
  assert.equal(payload.ok, true, `${method} failed: ${payload.error?.message}`)
  return payload.result
}
