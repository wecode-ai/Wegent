import { fetchLocalRuntime } from './runtime-request.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const TRANSPORT_RETRY_DELAYS_MS = [250, 1_000]

class ExecutorTransportFailure extends Error {
  constructor(method, stage, requestId, cause) {
    super(`${method} failed during ${stage} (${requestId})`, { cause })
    this.name = 'DesktopE2EExecutorTransportFailure'
  }
}

export async function requestExecutor(
  control,
  method,
  params,
  timeoutMs,
  { retryOnTransport = false } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestExecutorOnce(control, method, params, timeoutMs)
    } catch (error) {
      const retryDelay = TRANSPORT_RETRY_DELAYS_MS[attempt]
      if (
        !retryOnTransport ||
        !(error instanceof ExecutorTransportFailure) ||
        retryDelay === undefined
      ) {
        throw error
      }
      console.warn('[desktop-e2e] retrying idempotent Executor RPC after transport failure', {
        method,
        attempt: attempt + 1,
        retryDelay,
      })
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
}

async function requestExecutorOnce(control, method, params, timeoutMs) {
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
    throw new ExecutorTransportFailure(method, stage, requestId, cause)
  }
  assert.equal(
    response.ok,
    true,
    `${method} returned HTTP ${response.status}: ${payload.error?.message}`
  )
  assert.equal(payload.ok, true, `${method} failed: ${payload.error?.message}`)
  return payload.result
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
