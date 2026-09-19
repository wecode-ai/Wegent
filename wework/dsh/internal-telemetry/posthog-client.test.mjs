import assert from 'node:assert/strict'
import test from 'node:test'

import { createPostHogClient } from './posthog-client.js'

const PROJECT_KEY = 'phc_example'
const PROJECTED_EVENT = {
  event: 'smart_app_opened',
  uuid: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
  timestamp: '2026-09-10T08:00:00.000Z',
  properties: {
    distinct_id: 'wework:7afed3bd96637c04bba103ffbde70606f9d63674738bc2dd3651dfb4654a2a02',
  },
}

test('posts projected events only to the fixed PostHog batch endpoint', async () => {
  const requests = []
  const client = createPostHogClient({
    host: 'https://posthog.intra.example',
    projectKey: PROJECT_KEY,
    timeoutMs: 5000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return { status: 200 }
    },
  })

  assert.deepEqual(await client.sendBatch([PROJECTED_EVENT]), { status: 'accepted' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://posthog.intra.example/batch/')
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(requests[0].init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    api_key: PROJECT_KEY,
    batch: [PROJECTED_EVENT],
  })
  assert.ok(requests[0].init.signal instanceof AbortSignal)
})

test('classifies PostHog responses and transport failures without reading their bodies', async () => {
  for (const status of [200, 202, 204]) {
    const client = clientFor(async () => ({ status }))
    assert.deepEqual(await client.sendBatch([PROJECTED_EVENT]), { status: 'accepted' })
  }

  for (const [status, code] of [
    [408, 'posthog_timeout'],
    [429, 'posthog_rate_limited'],
    [500, 'posthog_unavailable'],
    [599, 'posthog_unavailable'],
  ]) {
    const client = clientFor(async () => ({ status, text: forbiddenBodyReader }))
    assert.deepEqual(await client.sendBatch([PROJECTED_EVENT]), {
      status: 'retryable_error',
      code,
    })
  }

  const rejectedClient = clientFor(async () => ({ status: 401, text: forbiddenBodyReader }))
  assert.deepEqual(await rejectedClient.sendBatch([PROJECTED_EVENT]), {
    status: 'permanent_error',
    code: 'posthog_rejected',
  })

  const timeoutClient = clientFor(async () => {
    throw new DOMException('timeout', 'AbortError')
  })
  assert.deepEqual(await timeoutClient.sendBatch([PROJECTED_EVENT]), {
    status: 'retryable_error',
    code: 'posthog_timeout',
  })
})

test('rejects oversized batches before making a request', async () => {
  let calls = 0
  const client = clientFor(async () => {
    calls += 1
    return { status: 200 }
  })

  assert.deepEqual(await client.sendBatch(Array.from({ length: 21 }, () => PROJECTED_EVENT)), {
    status: 'permanent_error',
    code: 'batch_too_large',
  })
  assert.deepEqual(
    await client.sendBatch([
      {
        ...PROJECTED_EVENT,
        properties: { detail: 'x'.repeat(256 * 1024) },
      },
    ]),
    {
      status: 'permanent_error',
      code: 'batch_too_large',
    }
  )
  assert.equal(calls, 0)
})

test('logs transport failures with a stable redacted message', async () => {
  const messages = []
  const client = createPostHogClient({
    host: 'https://posthog.intra.example',
    projectKey: PROJECT_KEY,
    timeoutMs: 5000,
    fetchImpl: async () => {
      throw new Error(`failed with ${PROJECT_KEY} and ${JSON.stringify(PROJECTED_EVENT)}`)
    },
    logger: {
      warn(message, metadata) {
        messages.push({ message, metadata })
      },
    },
  })

  assert.deepEqual(await client.sendBatch([PROJECTED_EVENT]), {
    status: 'retryable_error',
    code: 'posthog_unavailable',
  })
  assert.deepEqual(messages, [
    {
      message: '[wework-internal-telemetry] PostHog request failed',
      metadata: { code: 'posthog_unavailable' },
    },
  ])
})

function clientFor(fetchImpl) {
  return createPostHogClient({
    host: 'https://posthog.intra.example',
    projectKey: PROJECT_KEY,
    timeoutMs: 5000,
    fetchImpl,
  })
}

function forbiddenBodyReader() {
  throw new Error('response body must not be read')
}
