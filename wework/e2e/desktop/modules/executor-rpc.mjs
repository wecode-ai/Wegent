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
    for (let attempt = 0; ; attempt += 1) {
      response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ id: requestId, method, params }),
        timeoutMs,
      })
      stage = 'response-body'
      payload = await response.json()
      // Transcript reads can race with another read and answer busy for a moment.
      if (response.ok || attempt >= 4 || !isTranscriptBusy(payload)) break
      await new Promise(resolvePromise =>
        setTimeout(resolvePromise, Math.min(2_000, 250 * 2 ** attempt))
      )
    }
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

function isTranscriptBusy(payload) {
  const message = JSON.stringify(payload ?? {})
  return message.includes('Transcript processing is busy')
}

export async function writeCodexModelConfig(control, { provider, model }, timeoutMs) {
  for (const [keyPath, value] of [
    ['model_provider', provider],
    ['model', model],
  ]) {
    await requestExecutor(
      control,
      'runtime.codex.app_server.request',
      { method: 'config/value/write', params: { keyPath, value, mergeStrategy: 'replace' } },
      timeoutMs
    )
  }
}
