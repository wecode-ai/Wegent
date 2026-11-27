import { fetchLocalRuntime } from './runtime-request.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Keep native RPC failure details available without resubmitting a request. */
export class ExecutorRpcError extends assert.AssertionError {
  constructor(method, response, payload) {
    super({
      actual: response.ok ? payload.ok : response.ok,
      expected: true,
      operator: 'strictEqual',
      message: response.ok
        ? `${method} failed: ${payload.error?.message}`
        : `${method} returned HTTP ${response.status}: ${payload.error?.message}`,
    })
    this.rpcMethod = method
    this.httpStatus = response.status
    this.rpcOk = payload.ok
    this.rpcCode = payload.error?.code
    this.rpcMessage = payload.error?.message
  }
}

export async function requestExecutor(control, method, params, timeoutMs, { origin } = {}) {
  const runtimeOrigin = origin ?? (await control.command('getLocationOrigin', 'body'))
  const requestId = `desktop-e2e-${method}-${randomUUID()}`
  const startedAt = Date.now()
  let stage = 'response-headers'
  let response
  let payload
  try {
    response = await fetchLocalRuntime(control, `${runtimeOrigin}/wework/executor/v1/rpc`, {
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
  if (!response.ok || payload.ok !== true) throw new ExecutorRpcError(method, response, payload)
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
