import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

const CONFIG_FILE_NAME = 'internal-telemetry.env'
const CONFIG_DIRECTORY_NAME = 'config'
const DEFAULTS = Object.freeze({
  enabled: false,
  releaseChannel: 'development',
  batchSize: 20,
  flushIntervalMs: 5000,
  maxQueueSize: 500,
  requestTimeoutMs: 5000,
})
const NUMERIC_CONFIG = Object.freeze([
  {
    key: 'BATCH_SIZE',
    publicKey: 'batchSize',
    defaultValue: DEFAULTS.batchSize,
    minimum: 1,
    maximum: 20,
    error: 'invalid_batch_size',
  },
  {
    key: 'FLUSH_INTERVAL_MS',
    publicKey: 'flushIntervalMs',
    defaultValue: DEFAULTS.flushIntervalMs,
    minimum: 1000,
    maximum: 60000,
    error: 'invalid_flush_interval_ms',
  },
  {
    key: 'MAX_QUEUE_SIZE',
    publicKey: 'maxQueueSize',
    defaultValue: DEFAULTS.maxQueueSize,
    minimum: 20,
    maximum: 500,
    error: 'invalid_max_queue_size',
  },
  {
    key: 'REQUEST_TIMEOUT_MS',
    publicKey: 'requestTimeoutMs',
    defaultValue: DEFAULTS.requestTimeoutMs,
    minimum: 1000,
    maximum: 30000,
    error: 'invalid_request_timeout_ms',
  },
])
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export class TelemetryConfigError extends Error {
  constructor(code) {
    super('Telemetry configuration could not be read')
    this.name = 'TelemetryConfigError'
    this.code = code
  }
}

export async function readTelemetryEnvFile({ environment = process.env, read = readFile } = {}) {
  const dshHome = nonEmptyString(environment.DSH_HOME)
  if (!dshHome) return {}

  const filePath = join(dshHome, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME)
  try {
    return parseEnv(await read(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new TelemetryConfigError('config_read_failed')
  }
}

export async function loadTelemetryConfig({ environment = process.env, read } = {}) {
  let fileEnvironment
  try {
    fileEnvironment = await readTelemetryEnvFile({ environment, read })
  } catch (error) {
    return createConfig({
      publicConfig: publicConfig('config_read_failed'),
      privateConfig: emptyPrivateConfig(),
    })
  }

  const values = resolveConfigValues(environment, fileEnvironment)
  const publicValues = parsePublicValues(values)
  if (publicValues.error) {
    return createConfig({
      publicConfig: publicConfig(publicValues.error, publicValues.values),
      privateConfig: emptyPrivateConfig(),
    })
  }

  if (!publicValues.enabled) {
    return createConfig({
      publicConfig: publicConfig('disabled', publicValues.values),
      privateConfig: emptyPrivateConfig(),
    })
  }

  const privateValues = parsePrivateValues(values, environment)
  if (privateValues.error) {
    return createConfig({
      publicConfig: publicConfig(privateValues.error, publicValues.values),
      privateConfig: emptyPrivateConfig(),
    })
  }

  return createConfig({
    publicConfig: publicConfig(null, publicValues.values),
    privateConfig: privateValues.values,
  })
}

function resolveConfigValues(environment, fileEnvironment) {
  const values = {}
  for (const key of [
    'WEWORK_INTERNAL_TELEMETRY_ENABLED',
    'POSTHOG_HOST',
    'POSTHOG_PROJECT_KEY',
    'IDENTITY_HMAC_KEY',
    'RELEASE_CHANNEL',
    ...NUMERIC_CONFIG.map(config => config.key),
  ]) {
    values[key] = firstNonEmptyString(environment[key], fileEnvironment[key])
  }
  return values
}

function parsePublicValues(values) {
  const enabled = parseEnabled(values.WEWORK_INTERNAL_TELEMETRY_ENABLED)
  if (enabled === null) {
    return {
      error: 'invalid_enabled',
      values: { ...DEFAULTS, enabled: false },
    }
  }

  const parsed = {
    ...DEFAULTS,
    enabled,
    releaseChannel: values.RELEASE_CHANNEL ?? DEFAULTS.releaseChannel,
  }
  for (const config of NUMERIC_CONFIG) {
    const value = parseBoundedInteger(values[config.key], config)
    if (value === null) {
      return {
        error: config.error,
        values: parsed,
      }
    }
    parsed[config.publicKey] = value
  }

  return { error: null, enabled, values: parsed }
}

function parsePrivateValues(values, environment) {
  const posthogHost = parsePosthogHost(values.POSTHOG_HOST, environment.NODE_ENV === 'test')
  if (posthogHost.error) return posthogHost

  const posthogProjectKey = nonEmptyString(values.POSTHOG_PROJECT_KEY)
  if (!posthogProjectKey) return { error: 'missing_posthog_project_key' }

  const identityHmacKey = nonEmptyString(values.IDENTITY_HMAC_KEY)
  if (!identityHmacKey || utf8ByteLength(identityHmacKey) < 32) {
    return { error: 'invalid_identity_hmac_key' }
  }

  return {
    values: freezePrivateConfig({
      posthogHost: posthogHost.value,
      posthogProjectKey,
      identityHmacKey,
    }),
  }
}

function parseEnabled(value) {
  if (value === undefined) return DEFAULTS.enabled
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function parseBoundedInteger(value, config) {
  if (value === undefined) return config.defaultValue
  if (!/^\d+$/.test(value)) return null

  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < config.minimum || number > config.maximum) {
    return null
  }
  return number
}

function parsePosthogHost(value, allowHttpLoopback) {
  const host = nonEmptyString(value)
  if (!host) return { error: 'missing_posthog_host' }
  if (host.includes('@') || host.includes('?') || host.includes('#')) {
    return { error: 'invalid_posthog_host' }
  }

  try {
    const url = new URL(host)
    const isHttps = url.protocol === 'https:'
    const isAllowedHttpLoopback =
      allowHttpLoopback && url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname)
    if (
      (!isHttps && !isAllowedHttpLoopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return { error: 'invalid_posthog_host' }
    }

    return { value: trimTrailingSlash(url.toString()) }
  } catch {
    return { error: 'invalid_posthog_host' }
  }
}

function publicConfig(error, values = DEFAULTS) {
  return Object.freeze({
    enabled: error === null,
    error,
    releaseChannel: values.releaseChannel,
    batchSize: values.batchSize,
    flushIntervalMs: values.flushIntervalMs,
    maxQueueSize: values.maxQueueSize,
    requestTimeoutMs: values.requestTimeoutMs,
  })
}

function emptyPrivateConfig() {
  return freezePrivateConfig({
    posthogHost: null,
    posthogProjectKey: null,
    identityHmacKey: null,
  })
}

function freezePrivateConfig(values) {
  Object.defineProperty(values, 'toJSON', {
    value: () => ({}),
    enumerable: false,
  })
  return Object.freeze(values)
}

function createConfig({ publicConfig: publicValues, privateConfig: privateValues }) {
  const config = { public: publicValues }
  Object.defineProperty(config, 'private', {
    value: privateValues,
    enumerable: false,
  })
  return Object.freeze(config)
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = nonEmptyString(value)
    if (normalized) return normalized
  }
  return undefined
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength
}
