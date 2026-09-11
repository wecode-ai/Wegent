import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadTelemetryConfig, readTelemetryEnvFile, TelemetryConfigError } from './config.js'

const VALID_HMAC_KEY = '0123456789abcdef0123456789abcdef'
const VALID_FILE = [
  'WEWORK_INTERNAL_TELEMETRY_ENABLED=true',
  'WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST=https://telemetry.example.test',
  'WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY=file-project-key',
  `WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY=${VALID_HMAC_KEY}`,
  'WEWORK_INTERNAL_TELEMETRY_RELEASE_CHANNEL=internal',
  'WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE=12',
  'WEWORK_INTERNAL_TELEMETRY_FLUSH_INTERVAL_MS=3000',
  'WEWORK_INTERNAL_TELEMETRY_MAX_QUEUE_SIZE=200',
  'WEWORK_INTERNAL_TELEMETRY_REQUEST_TIMEOUT_MS=6000',
].join('\n')

test('uses safe disabled defaults when the dedicated file is missing', async () => {
  await withTemporaryDshHome(async dshHome => {
    const config = await loadTelemetryConfig({
      environment: { DSH_HOME: dshHome },
    })

    assert.deepEqual(config.public, {
      enabled: false,
      error: 'disabled',
      releaseChannel: 'development',
      batchSize: 20,
      flushIntervalMs: 5000,
      maxQueueSize: 500,
      requestTimeoutMs: 5000,
    })
    assert.deepEqual(config.private, {
      posthogHost: null,
      posthogProjectKey: null,
      identityHmacKey: null,
    })
    assert.equal(Object.isFrozen(config), true)
    assert.equal(Object.isFrozen(config.public), true)
    assert.equal(Object.isFrozen(config.private), true)
  })
})

test('reads the dedicated env file without changing the supplied environment', async () => {
  await withTemporaryDshHome(async dshHome => {
    await writeTelemetryEnvFile(dshHome, VALID_FILE)
    const environment = { DSH_HOME: dshHome }

    assert.deepEqual(await readTelemetryEnvFile({ environment }), {
      WEWORK_INTERNAL_TELEMETRY_ENABLED: 'true',
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'https://telemetry.example.test',
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY: 'file-project-key',
      WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY: VALID_HMAC_KEY,
      WEWORK_INTERNAL_TELEMETRY_RELEASE_CHANNEL: 'internal',
      WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE: '12',
      WEWORK_INTERNAL_TELEMETRY_FLUSH_INTERVAL_MS: '3000',
      WEWORK_INTERNAL_TELEMETRY_MAX_QUEUE_SIZE: '200',
      WEWORK_INTERNAL_TELEMETRY_REQUEST_TIMEOUT_MS: '6000',
    })
    assert.deepEqual(environment, { DSH_HOME: dshHome })
  })
})

test('prefers non-empty process environment values over the dedicated file', async () => {
  await withTemporaryDshHome(async dshHome => {
    await writeTelemetryEnvFile(dshHome, VALID_FILE)

    const config = await loadTelemetryConfig({
      environment: {
        DSH_HOME: dshHome,
        WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY: 'environment-project-key',
        WEWORK_INTERNAL_TELEMETRY_RELEASE_CHANNEL: 'canary',
        WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE: '20',
        WEWORK_INTERNAL_TELEMETRY_MAX_QUEUE_SIZE: '',
      },
    })

    assert.deepEqual(config.public, {
      enabled: true,
      error: null,
      releaseChannel: 'canary',
      batchSize: 20,
      flushIntervalMs: 3000,
      maxQueueSize: 200,
      requestTimeoutMs: 6000,
    })
    assert.equal(config.private.posthogProjectKey, 'environment-project-key')
  })
})

test('reports a missing PostHog host without throwing to callers', async () => {
  const config = await loadTelemetryConfig({
    environment: enabledEnvironment({ WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: '' }),
  })

  assert.deepEqual(config.public, publicConfig('missing_posthog_host'))
  assert.deepEqual(config.private, privateConfig())
})

test('rejects disallowed PostHog URLs', async () => {
  for (const posthogHost of [
    'http://telemetry.example.test',
    'https://user:password@telemetry.example.test',
    'https://telemetry.example.test/?query=value',
    'https://telemetry.example.test/#fragment',
    'https://@telemetry.example.test',
    'https://telemetry.example.test?',
    'https://telemetry.example.test#',
  ]) {
    const config = await loadTelemetryConfig({
      environment: enabledEnvironment({ WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: posthogHost }),
    })

    assert.deepEqual(config.public, publicConfig('invalid_posthog_host'))
  }
})

test('allows an http loopback host only in a test environment', async () => {
  const accepted = await loadTelemetryConfig({
    environment: enabledEnvironment({
      NODE_ENV: 'test',
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://localhost:8000',
    }),
  })
  const rejected = await loadTelemetryConfig({
    environment: enabledEnvironment({
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://localhost:8000',
    }),
  })
  const whitespacePadded = await loadTelemetryConfig({
    environment: enabledEnvironment({
      NODE_ENV: ' test ',
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://localhost:8000',
    }),
  })

  assert.equal(accepted.public.error, null)
  assert.equal(accepted.private.posthogHost, 'http://localhost:8000')
  assert.deepEqual(rejected.public, publicConfig('invalid_posthog_host'))
  assert.deepEqual(whitespacePadded.public, publicConfig('invalid_posthog_host'))
})

test('allows HTTP only for the explicitly configured private PostHog host', async () => {
  const accepted = await loadTelemetryConfig({
    environment: enabledEnvironment({
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://10.0.0.8',
      WEWORK_INTERNAL_TELEMETRY_ALLOW_HTTP_POSTHOG_HOST: '10.0.0.8',
    }),
  })
  const wrongHost = await loadTelemetryConfig({
    environment: enabledEnvironment({
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://10.0.0.9',
      WEWORK_INTERNAL_TELEMETRY_ALLOW_HTTP_POSTHOG_HOST: '10.0.0.8',
    }),
  })
  const publicHost = await loadTelemetryConfig({
    environment: enabledEnvironment({
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://203.0.113.8',
      WEWORK_INTERNAL_TELEMETRY_ALLOW_HTTP_POSTHOG_HOST: '203.0.113.8',
    }),
  })

  assert.equal(accepted.public.error, null)
  assert.equal(accepted.private.posthogHost, 'http://10.0.0.8')
  assert.deepEqual(wrongHost.public, publicConfig('invalid_posthog_host'))
  assert.deepEqual(publicHost.public, publicConfig('invalid_posthog_host'))
})

test('rejects absent project keys and configured HMAC keys that are too short', async () => {
  const missingProjectKey = await loadTelemetryConfig({
    environment: enabledEnvironment({ WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY: '' }),
  })
  const invalidHmacKey = await loadTelemetryConfig({
    environment: enabledEnvironment({ WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY: 'too-short' }),
  })

  assert.deepEqual(missingProjectKey.public, publicConfig('missing_posthog_project_key'))
  assert.deepEqual(invalidHmacKey.public, publicConfig('invalid_identity_hmac_key'))
})

test('allows email-prefix telemetry without an HMAC key', async () => {
  const config = await loadTelemetryConfig({
    environment: enabledEnvironment({ WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY: '' }),
  })

  assert.deepEqual(config.public, publicConfig(null))
  assert.deepEqual(config.private, {
    posthogHost: 'https://telemetry.example.test',
    posthogProjectKey: 'project-key',
    identityHmacKey: null,
  })
})

test('accepts every numeric lower and upper boundary', async () => {
  for (const [name, lower, upper] of [
    ['WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE', 1, 20],
    ['WEWORK_INTERNAL_TELEMETRY_FLUSH_INTERVAL_MS', 1000, 60000],
    ['WEWORK_INTERNAL_TELEMETRY_MAX_QUEUE_SIZE', 20, 500],
    ['WEWORK_INTERNAL_TELEMETRY_REQUEST_TIMEOUT_MS', 1000, 30000],
  ]) {
    for (const value of [lower, upper]) {
      const config = await loadTelemetryConfig({
        environment: enabledEnvironment({ [name]: String(value) }),
      })

      assert.equal(config.public.error, null, `${name}=${value} should be accepted`)
    }
  }
})

test('rejects numeric values outside every allowed boundary', async () => {
  for (const [name, below, above, error] of [
    ['WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE', 0, 21, 'invalid_batch_size'],
    ['WEWORK_INTERNAL_TELEMETRY_FLUSH_INTERVAL_MS', 999, 60001, 'invalid_flush_interval_ms'],
    ['WEWORK_INTERNAL_TELEMETRY_MAX_QUEUE_SIZE', 19, 501, 'invalid_max_queue_size'],
    ['WEWORK_INTERNAL_TELEMETRY_REQUEST_TIMEOUT_MS', 999, 30001, 'invalid_request_timeout_ms'],
  ]) {
    for (const value of [below, above]) {
      const config = await loadTelemetryConfig({
        environment: enabledEnvironment({ [name]: String(value) }),
      })

      assert.deepEqual(config.public, publicConfig(error), `${name}=${value} should be rejected`)
    }
  }
})

test('keeps numeric validation closed even while telemetry is disabled', async () => {
  const config = await loadTelemetryConfig({
    environment: { WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE: 'invalid' },
  })

  assert.deepEqual(config.public, publicConfig('invalid_batch_size', { enabled: false }))
})

test('wraps dedicated env file read failures and returns a safe public state', async () => {
  const read = async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  }

  await assert.rejects(
    () => readTelemetryEnvFile({ environment: { DSH_HOME: '/tmp/dsh-home' }, read }),
    error => error instanceof TelemetryConfigError && error.code === 'config_read_failed'
  )

  const config = await loadTelemetryConfig({
    environment: { DSH_HOME: '/tmp/dsh-home' },
    read,
  })

  assert.deepEqual(config.public, publicConfig('config_read_failed', { enabled: false }))
})

test('never serializes PostHog or HMAC secrets in public config or error states', async () => {
  const projectKey = 'project-key-that-must-not-leak'
  const hmacKey = 'hmac-key-that-must-not-leak-0123456789'
  const invalidConfig = await loadTelemetryConfig({
    environment: enabledEnvironment({
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'http://telemetry.example.test',
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY: projectKey,
      WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY: hmacKey,
    }),
  })
  const validConfig = await loadTelemetryConfig({
    environment: enabledEnvironment({
      WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY: projectKey,
      WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY: hmacKey,
    }),
  })

  const serialized = JSON.stringify(invalidConfig)
  assert.equal('posthogHost' in invalidConfig.public, false)
  assert.equal('posthogProjectKey' in invalidConfig.public, false)
  assert.equal('identityHmacKey' in invalidConfig.public, false)
  assert.equal(serialized.includes(projectKey), false)
  assert.equal(serialized.includes(hmacKey), false)
  assert.equal(JSON.stringify(invalidConfig.public).includes(projectKey), false)
  assert.equal(JSON.stringify(invalidConfig.public).includes(hmacKey), false)
  assert.equal(JSON.stringify(validConfig).includes(projectKey), false)
  assert.equal(JSON.stringify(validConfig).includes(hmacKey), false)
  assert.equal(JSON.stringify(validConfig.private).includes(projectKey), false)
  assert.equal(JSON.stringify(validConfig.private).includes(hmacKey), false)
})

function enabledEnvironment(overrides = {}) {
  return {
    WEWORK_INTERNAL_TELEMETRY_ENABLED: 'true',
    WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST: 'https://telemetry.example.test',
    WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY: 'project-key',
    WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY: VALID_HMAC_KEY,
    ...overrides,
  }
}

function publicConfig(error, overrides = {}) {
  return {
    enabled: error === null,
    error,
    releaseChannel: 'development',
    batchSize: 20,
    flushIntervalMs: 5000,
    maxQueueSize: 500,
    requestTimeoutMs: 5000,
    ...overrides,
  }
}

function privateConfig() {
  return {
    posthogHost: null,
    posthogProjectKey: null,
    identityHmacKey: null,
  }
}

async function withTemporaryDshHome(action) {
  const directory = await mkdtemp(join(tmpdir(), 'internal-telemetry-config-'))
  try {
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeTelemetryEnvFile(dshHome, contents) {
  const configDirectory = join(dshHome, 'config')
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(configDirectory, 'internal-telemetry.env'), contents, 'utf8')
}
