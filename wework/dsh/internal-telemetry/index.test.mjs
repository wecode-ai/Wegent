import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWithDependencies, name, TELEMETRY_SINK_PROTOCOL } from './index.js'

const HMAC_KEY = '0123456789abcdef0123456789abcdef'

test('registers a disabled host without creating network resources', async () => {
  const runtime = createHostRuntime()
  const warnings = []
  let createdClient = false
  let createdQueue = false

  await applyWithDependencies(runtime.context, {
    createBatchQueue() {
      createdQueue = true
    },
    createPostHogClient() {
      createdClient = true
    },
    loadConfig: async () => disabledConfig('missing_posthog_host'),
    logger: { warn: (message, metadata) => warnings.push({ message, metadata }) },
  })

  const methods = runtime.registration.methods
  assert.deepEqual(await methods.ready(), {
    enabled: false,
    protocol: TELEMETRY_SINK_PROTOCOL,
    catalogVersion: 1,
    error: 'missing_posthog_host',
  })
  assert.deepEqual(await methods.accept({ envelope: smartAppEnvelope() }), {
    accepted: false,
    reason: 'disabled',
  })
  assert.equal(createdClient, false)
  assert.equal(createdQueue, false)
  assert.deepEqual(warnings, [
    {
      message: '[wework-internal-telemetry] disabled',
      metadata: { code: 'missing_posthog_host' },
    },
  ])
})

test('composes enabled runtime dependencies and queues a projected event without waiting for network', async () => {
  const runtime = createHostRuntime({ version: '2.0.0' })
  const queuedEvents = []
  const calls = {}
  const queue = fakeQueue(queuedEvents)

  await applyWithDependencies(runtime.context, {
    createBatchQueue(options) {
      calls.queue = options
      return queue
    },
    createPostHogClient(options) {
      calls.client = options
      return { sendBatch: async () => ({ status: 'accepted' }) }
    },
    loadConfig: async () => enabledConfig(),
    platform: 'darwin',
  })

  assert.equal(name, 'wework-internal-telemetry')
  assert.deepEqual(runtime.registration.methods.ready(), {
    enabled: true,
    protocol: TELEMETRY_SINK_PROTOCOL,
    catalogVersion: 1,
    error: null,
  })
  assert.equal(calls.client.host, 'https://telemetry.example.test')
  assert.equal(calls.client.projectKey, 'phc_example')
  assert.equal(calls.client.timeoutMs, 5000)
  assert.equal(calls.queue.batchSize, 20)
  assert.equal(calls.queue.flushIntervalMs, 5000)
  assert.equal(calls.queue.maxQueueSize, 500)

  assert.deepEqual(await runtime.registration.methods.accept({ envelope: smartAppEnvelope() }), {
    accepted: true,
  })
  assert.equal(queuedEvents.length, 1)
  assert.deepEqual(queuedEvents[0], {
    event: 'smart_app_opened',
    uuid: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
    timestamp: '2026-09-10T08:00:00.000Z',
    properties: {
      distinct_id: 'wework:a651a6e29b5939094128b5d77ac45e8d1be01b2cf18b4a23a497893666230921',
      $geoip_disable: true,
      domain: 'smart_app',
      event_schema_version: 1,
      telemetry_source: 'internal_plugin',
      app_version: '2.0.0',
      platform: 'mac',
      release_channel: 'stable',
      smart_app_key: 'example',
      smart_app_name: 'Example',
      smart_app_version: '1.0.0',
      smart_app_source: 'managed',
    },
  })
})

test('uses the host cloud email prefix when the event has only a local user', async () => {
  const runtime = createHostRuntime({
    preferences: {
      cloudConnection: {
        user: { email: 'cloud-user@example.com' },
      },
    },
  })
  const queuedEvents = []

  await applyWithDependencies(runtime.context, {
    createBatchQueue: () => fakeQueue(queuedEvents),
    createPostHogClient: () => ({ sendBatch: async () => ({ status: 'accepted' }) }),
    loadConfig: async () => enabledConfig({ identityHmacKey: null }),
    platform: 'linux',
  })

  assert.deepEqual(
    await runtime.registration.methods.accept({
      envelope: smartAppEnvelope({
        context: {
          user: { id: 0, email: '', userName: 'backend' },
          smartApp: {
            key: 'example',
            name: 'Example',
            version: '1.0.0',
            source: 'managed',
          },
        },
      }),
    }),
    { accepted: true }
  )
  assert.equal(queuedEvents.length, 1)
  assert.equal(queuedEvents[0].properties.distinct_id, 'cloud-user')
})

test('enriches a directly captured smart app opening from the local installation registry', async () => {
  const runtime = createHostRuntime()
  const queuedEvents = []
  let requestedInstallationId = null

  await applyWithDependencies(runtime.context, {
    createBatchQueue: () => fakeQueue(queuedEvents),
    createPostHogClient: () => ({ sendBatch: async () => ({ status: 'accepted' }) }),
    createSmartAppRegistry() {
      return {
        async find(installationId) {
          requestedInstallationId = installationId
          return {
            key: 'research-desk',
            name: 'Research Desk',
            version: '1.2.3',
            source: 'managed',
          }
        },
      }
    },
    loadConfig: async () => enabledConfig(),
    platform: 'darwin',
  })

  assert.deepEqual(
    await runtime.registration.methods.accept({
      envelope: smartAppEnvelope({ context: undefined }),
      identity: { id: 42 },
      smartAppInstallationId: 'research-desk',
    }),
    { accepted: true }
  )
  assert.equal(requestedInstallationId, 'research-desk')
  assert.equal(queuedEvents[0].properties.smart_app_key, 'research-desk')
  assert.equal(queuedEvents[0].properties.smart_app_name, 'Research Desk')
  assert.equal(queuedEvents[0].properties.smart_app_version, '1.2.3')
  assert.equal(queuedEvents[0].properties.smart_app_source, 'managed')
})

test('rejects invalid envelopes and only returns privacy-safe aggregate status', async () => {
  const runtime = createHostRuntime()
  const queue = fakeQueue([])

  await applyWithDependencies(runtime.context, {
    createBatchQueue: () => queue,
    createPostHogClient: () => ({ sendBatch: async () => ({ status: 'accepted' }) }),
    loadConfig: async () => enabledConfig(),
    platform: 'linux',
  })
  const methods = runtime.registration.methods

  assert.deepEqual(await methods.accept({ envelope: smartAppEnvelope() }), { accepted: true })
  assert.deepEqual(
    await methods.accept({
      envelope: smartAppEnvelope({
        properties: { domain: 'smart_app', file_path: '/Users/private/workbench.zip' },
      }),
    }),
    { accepted: false, reason: 'unknown_property' }
  )

  const serialized = JSON.stringify(await methods.status())
  for (const value of [
    'private@example.com',
    'private-user',
    'Example',
    'phc_example',
    HMAC_KEY,
    '/Users/private',
  ]) {
    assert.equal(serialized.includes(value), false)
  }
  assert.match(serialized, /"received":2/)
  assert.match(serialized, /"projected":1/)
  assert.match(serialized, /"rejected":1/)
})

test('disposes queue with a one-second budget and disables further accepts', async () => {
  const runtime = createHostRuntime()
  const queue = fakeQueue([])

  await applyWithDependencies(runtime.context, {
    createBatchQueue: () => queue,
    createPostHogClient: () => ({ sendBatch: async () => ({ status: 'accepted' }) }),
    loadConfig: async () => enabledConfig(),
    platform: 'win32',
  })
  const methods = runtime.registration.methods

  for (const cleanup of runtime.cleanups.splice(0).reverse()) cleanup()

  assert.deepEqual(queue.disposeOptions, { timeoutMs: 1000 })
  assert.equal(runtime.registrationActive, false)
  assert.deepEqual(await methods.accept({ envelope: smartAppEnvelope() }), {
    accepted: false,
    reason: 'disabled',
  })
})

function createHostRuntime({ version = '2.0.0', preferences = {} } = {}) {
  const cleanups = []
  const runtime = {
    registration: null,
    registrationActive: true,
  }
  const context = {
    effect(factory) {
      const cleanup = factory()
      cleanups.push(cleanup)
      return cleanup
    },
    weworkDesktop: {
      app: {
        async getVersion() {
          return { version }
        },
      },
      preferences: {
        async get() {
          return preferences
        },
      },
    },
    weworkPluginRuntime: {
      register(owner, registration) {
        runtime.registration = registration
        owner.effect(() => () => {
          runtime.registrationActive = false
        })
      },
    },
  }
  runtime.cleanups = cleanups
  runtime.context = context
  return runtime
}

function fakeQueue(events) {
  return {
    disposeOptions: null,
    enqueue(event) {
      events.push(event)
      return true
    },
    status() {
      return {
        queuedEvents: events.length,
        droppedEvents: 0,
        sentBatches: 0,
        sentEvents: 0,
        retries: 0,
        permanentFailedBatches: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCode: null,
      }
    },
    dispose(options) {
      this.disposeOptions = options
      return new Promise(() => {})
    },
  }
}

function disabledConfig(error) {
  return {
    public: {
      enabled: false,
      error,
      releaseChannel: 'development',
      batchSize: 20,
      flushIntervalMs: 5000,
      maxQueueSize: 500,
      requestTimeoutMs: 5000,
    },
    private: {
      posthogHost: null,
      posthogProjectKey: null,
      identityHmacKey: null,
    },
  }
}

function enabledConfig(privateOverrides = {}) {
  return {
    public: {
      enabled: true,
      error: null,
      releaseChannel: 'stable',
      batchSize: 20,
      flushIntervalMs: 5000,
      maxQueueSize: 500,
      requestTimeoutMs: 5000,
    },
    private: {
      posthogHost: 'https://telemetry.example.test',
      posthogProjectKey: 'phc_example',
      identityHmacKey: HMAC_KEY,
      ...privateOverrides,
    },
  }
}

function smartAppEnvelope(overrides = {}) {
  return {
    eventId: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
    name: 'smart_app_opened',
    occurredAt: '2026-09-10T08:00:00.000Z',
    properties: { domain: 'smart_app' },
    context: {
      user: {
        id: 42,
        email: 'private@example.com',
        userName: 'private-user',
      },
      smartApp: {
        key: 'example',
        name: 'Example',
        version: '1.0.0',
        source: 'managed',
      },
    },
    ...overrides,
  }
}
