import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadTelemetryConfig, readTelemetryEnvFile, TelemetryConfigError } from './config.js'

const VALID_HMAC_KEY = '0123456789abcdef0123456789abcdef'
const VALID_FILE = [
  'WEWORK_INTERNAL_TELEMETRY_ENABLED=true',
  'POSTHOG_HOST=https://telemetry.example.test',
  'POSTHOG_PROJECT_KEY=file-project-key',
  `IDENTITY_HMAC_KEY=${VALID_HMAC_KEY}`,
  'RELEASE_CHANNEL=internal',
  'BATCH_SIZE=12',
  'FLUSH_INTERVAL_MS=3000',
  'MAX_QUEUE_SIZE=200',
  'REQUEST_TIMEOUT_MS=6000',
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
      POSTHOG_HOST: 'https://telemetry.example.test',
      POSTHOG_PROJECT_KEY: 'file-project-key',
      IDENTITY_HMAC_KEY: VALID_HMAC_KEY,
      RELEASE_CHANNEL: 'internal',
      BATCH_SIZE: '12',
      FLUSH_INTERVAL_MS: '3000',
      MAX_QUEUE_SIZE: '200',
      REQUEST_TIMEOUT_MS: '6000',
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
        POSTHOG_PROJECT_KEY: 'environment-project-key',
        RELEASE_CHANNEL: 'canary',
        BATCH_SIZE: '20',
        MAX_QUEUE_SIZE: '',
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
    environment: enabledEnvironment({ POSTHOG_HOST: '' }),
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
      environment: enabledEnvironment({ POSTHOG_HOST: posthogHost }),
    })

    assert.deepEqual(config.public, publicConfig('invalid_posthog_host'))
  }
})

test('allows an http loopback host only in a test environment', async () => {
  const accepted = await loadTelemetryConfig({
    environment: enabledEnvironment({
      NODE_ENV: 'test',
      POSTHOG_HOST: 'http://localhost:8000',
    }),
  })
  const rejected = await loadTelemetryConfig({
    environment: enabledEnvironment({
      POSTHOG_HOST: 'http://localhost:8000',
    }),
  })
  const whitespacePadded = await loadTelemetryConfig({
    environment: enabledEnvironment({
      NODE_ENV: ' test ',
      POSTHOG_HOST: 'http://localhost:8000',
    }),
  })

  assert.equal(accepted.public.error, null)
  assert.equal(accepted.private.posthogHost, 'http://localhost:8000')
  assert.deepEqual(rejected.public, publicConfig('invalid_posthog_host'))
  assert.deepEqual(whitespacePadded.public, publicConfig('invalid_posthog_host'))
})

test('rejects absent project keys and too-short HMAC keys', async () => {
  const missingProjectKey = await loadTelemetryConfig({
    environment: enabledEnvironment({ POSTHOG_PROJECT_KEY: '' }),
  })
  const invalidHmacKey = await loadTelemetryConfig({
    environment: enabledEnvironment({ IDENTITY_HMAC_KEY: 'too-short' }),
  })

  assert.deepEqual(missingProjectKey.public, publicConfig('missing_posthog_project_key'))
  assert.deepEqual(invalidHmacKey.public, publicConfig('invalid_identity_hmac_key'))
})

test('accepts every numeric lower and upper boundary', async () => {
  for (const [name, lower, upper] of [
    ['BATCH_SIZE', 1, 20],
    ['FLUSH_INTERVAL_MS', 1000, 60000],
    ['MAX_QUEUE_SIZE', 20, 500],
    ['REQUEST_TIMEOUT_MS', 1000, 30000],
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
    ['BATCH_SIZE', 0, 21, 'invalid_batch_size'],
    ['FLUSH_INTERVAL_MS', 999, 60001, 'invalid_flush_interval_ms'],
    ['MAX_QUEUE_SIZE', 19, 501, 'invalid_max_queue_size'],
    ['REQUEST_TIMEOUT_MS', 999, 30001, 'invalid_request_timeout_ms'],
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
    environment: { BATCH_SIZE: 'invalid' },
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
      POSTHOG_HOST: 'http://telemetry.example.test',
      POSTHOG_PROJECT_KEY: projectKey,
      IDENTITY_HMAC_KEY: hmacKey,
    }),
  })
  const validConfig = await loadTelemetryConfig({
    environment: enabledEnvironment({
      POSTHOG_PROJECT_KEY: projectKey,
      IDENTITY_HMAC_KEY: hmacKey,
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
    POSTHOG_HOST: 'https://telemetry.example.test',
    POSTHOG_PROJECT_KEY: 'project-key',
    IDENTITY_HMAC_KEY: VALID_HMAC_KEY,
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
