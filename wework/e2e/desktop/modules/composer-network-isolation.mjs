import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export const PLUGIN_REMOTE_CATALOG_TIMEOUT_MS = 40_000

export async function withHeldComposerAppCatalog(control, proxy, verify) {
  const requestCount = proxy.requests.length
  let settled = false
  let failure
  const pending = requestExecutor(
    control,
    'codex.app_server_request',
    { method: 'app/list', params: { forceRefetch: true } },
    PLUGIN_REMOTE_CATALOG_TIMEOUT_MS
  ).then(
    () => {
      settled = true
    },
    error => {
      settled = true
      failure = error
    }
  )
  const assertPending = () =>
    assert.equal(
      settled,
      false,
      `The remote app catalog must remain pending during local inventory verification: ${failure?.message ?? 'request completed'}`
    )
  try {
    const blockedRequest = await waitForBlockedChatGptRequest(proxy, requestCount, assertPending)
    await verify(blockedRequest)
    assertPending()
  } finally {
    // Releasing the proxy intentionally returns 502 to its held connections.
    // Observe settlement so cleanup never leaves an unhandled background rejection.
    proxy.release()
    await pending
  }
}

async function waitForBlockedChatGptRequest(proxy, requestCount, assertPending) {
  const startedAt = Date.now()
  let blockedRequest
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    assertPending()
    blockedRequest = proxy.requests
      .slice(requestCount)
      .find(request => request.toLowerCase().includes('chatgpt.com'))
    if (blockedRequest) return blockedRequest
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `Codex app/list did not reach the blocking proxy; requests: ${JSON.stringify(proxy.requests.slice(requestCount))}`
  )
}
