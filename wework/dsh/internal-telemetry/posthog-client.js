const MAX_BATCH_EVENTS = 20
const MAX_BATCH_BYTES = 256 * 1024
const LOG_MESSAGE = '[wework-internal-telemetry] PostHog request failed'

export function createPostHogClient({
  host,
  projectKey,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  const batchUrl = `${trimTrailingSlash(host)}/batch/`

  return Object.freeze({
    async sendBatch(events) {
      const body = serializeBatch(events, projectKey)
      if (body === null || Buffer.byteLength(body) > MAX_BATCH_BYTES) {
        return permanentBatchTooLarge()
      }

      try {
        const response = await fetchImpl(batchUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
        return classifyResponse(response?.status)
      } catch (error) {
        const code =
          error?.name === 'AbortError' || error?.name === 'TimeoutError'
            ? 'posthog_timeout'
            : 'posthog_unavailable'
        logger?.warn?.(LOG_MESSAGE, { code })
        return { status: 'retryable_error', code }
      }
    },
  })
}

function serializeBatch(events, projectKey) {
  if (!Array.isArray(events) || events.length > MAX_BATCH_EVENTS) return null

  try {
    return JSON.stringify({
      api_key: projectKey,
      batch: events,
    })
  } catch {
    return null
  }
}

function classifyResponse(status) {
  if (status === 200 || status === 202 || status === 204) return { status: 'accepted' }
  if (status === 408) return { status: 'retryable_error', code: 'posthog_timeout' }
  if (status === 429) return { status: 'retryable_error', code: 'posthog_rate_limited' }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { status: 'retryable_error', code: 'posthog_unavailable' }
  }
  return { status: 'permanent_error', code: 'posthog_rejected' }
}

function permanentBatchTooLarge() {
  return { status: 'permanent_error', code: 'batch_too_large' }
}

function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
}
