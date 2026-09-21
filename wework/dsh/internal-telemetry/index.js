import { createBatchQueue } from './batch-queue.js'
import { eventCatalog, INTERNAL_TELEMETRY_CATALOG_VERSION } from './catalog.js'
import { deriveDistinctId } from './identity.js'
import { createPostHogClient } from './posthog-client.js'
import { projectEnvelope } from './projection.js'
import { createSmartAppRegistry } from './smart-app-registry.js'

export const name = 'wework-internal-telemetry'
export const inject = ['weworkDesktop', 'weworkPluginRuntime']
export const TELEMETRY_SINK_PROTOCOL = 'telemetry-sink/v1'

const PLUGIN_VERSION = '0.1.0'
const POSTHOG_HOST = 'https://posthog.intra.weibo.com'
const POSTHOG_PROJECT_KEY = 'phc_yVhzq3MARecWUuBmJJS3gdXbUWjLbdXjnqxa6V67DFsR'
const RELEASE_CHANNEL = 'development'
const REQUEST_TIMEOUT_MS = 5000
const BATCH_SIZE = 20
const FLUSH_INTERVAL_MS = 5000
const MAX_QUEUE_SIZE = 500

export async function apply(ctx) {
  await applyWithDependencies(ctx, {
    createBatchQueue,
    createPostHogClient,
    platform: process.platform,
  })
}

export async function applyWithDependencies(
  ctx,
  {
    createBatchQueue: createQueue,
    createPostHogClient: createClient,
    createSmartAppRegistry: createRegistry = createSmartAppRegistry,
    logger = console,
    platform,
  }
) {
  const metrics = {
    projected: 0,
    received: 0,
    rejected: 0,
  }
  let active = true
  let enabled = true
  let error = null
  let queue = null
  let runtime = null
  const smartAppRegistry = createRegistry()

  runtime = await resolveRuntime(ctx.weworkDesktop, RELEASE_CHANNEL, platform)
  if (!runtime) {
    enabled = false
    error = 'runtime_unavailable'
  }

  if (enabled) {
    const client = createClient({
      host: POSTHOG_HOST,
      projectKey: POSTHOG_PROJECT_KEY,
      timeoutMs: REQUEST_TIMEOUT_MS,
      logger: {
        warn(_message, metadata) {
          logger?.warn?.('[wework-internal-telemetry] batch failed', {
            code: metadata?.code ?? 'posthog_unavailable',
          })
        },
      },
    })
    queue = createQueue({
      sendBatch: events => client.sendBatch(events),
      batchSize: BATCH_SIZE,
      flushIntervalMs: FLUSH_INTERVAL_MS,
      maxQueueSize: MAX_QUEUE_SIZE,
      retryDelaysMs: [1000, 5000, 30000],
    })
  } else {
    logger?.warn?.('[wework-internal-telemetry] disabled', { code: error ?? 'disabled' })
  }

  ctx.weworkPluginRuntime.register(ctx, {
    id: name,
    methods: {
      ready: () => readyStatus(),
      accept: params => accept(params),
      status: () => status(),
    },
  })
  ctx.effect(
    () => () => {
      active = false
      void queue?.dispose({ timeoutMs: 1000 })
    },
    'wework-internal-telemetry: dispose'
  )

  function readyStatus() {
    return {
      enabled: active && enabled,
      protocol: TELEMETRY_SINK_PROTOCOL,
      catalogVersion: INTERNAL_TELEMETRY_CATALOG_VERSION,
      error: active && enabled ? null : (error ?? 'disabled'),
    }
  }

  async function accept({ envelope, identity, smartAppInstallationId } = {}) {
    if (!active || !enabled || !queue || !runtime) {
      return { accepted: false, reason: 'disabled' }
    }

    metrics.received += 1
    let distinctId
    try {
      const hostIdentity = await readCloudIdentity(ctx.weworkDesktop)
      distinctId = deriveDistinctId(hostIdentity ?? identity ?? envelope?.context?.user)
    } catch {
      metrics.rejected += 1
      return { accepted: false, reason: 'identity_unavailable' }
    }

    let projected
    try {
      const enrichedEnvelope = await enrichSmartAppEnvelope(
        envelope,
        smartAppInstallationId,
        smartAppRegistry
      )
      projected = projectEnvelope({
        catalog: eventCatalog,
        distinctId,
        envelope: enrichedEnvelope,
        runtime,
      })
    } catch {
      metrics.rejected += 1
      return { accepted: false, reason: 'invalid_envelope' }
    }

    if (!projected.ok) {
      metrics.rejected += 1
      return { accepted: false, reason: projected.reason }
    }

    queue.enqueue(projected.value)
    metrics.projected += 1
    return { accepted: true }
  }

  function status() {
    const queueStatus = queue?.status() ?? emptyQueueStatus()
    return {
      enabled: active && enabled,
      error: active && enabled ? null : (error ?? 'disabled'),
      protocol: TELEMETRY_SINK_PROTOCOL,
      catalogVersion: INTERNAL_TELEMETRY_CATALOG_VERSION,
      pluginVersion: PLUGIN_VERSION,
      received: metrics.received,
      projected: metrics.projected,
      rejected: metrics.rejected,
      ...queueStatus,
    }
  }
}

async function enrichSmartAppEnvelope(envelope, installationId, registry) {
  if (
    !isRecord(envelope) ||
    isRecord(envelope.context?.smartApp) ||
    !isBoundedString(installationId) ||
    !registry
  ) {
    return envelope
  }

  let smartApp
  try {
    smartApp = await registry.find(installationId)
  } catch {
    return envelope
  }
  if (!isSmartAppIdentity(smartApp)) return envelope

  return {
    ...envelope,
    context: {
      ...(isRecord(envelope.context) ? envelope.context : {}),
      smartApp,
    },
  }
}

async function readCloudIdentity(desktop) {
  try {
    const preferences = await desktop.preferences?.get?.()
    const email = preferences?.cloudConnection?.user?.email
    if (typeof email !== 'string') return undefined

    const normalizedEmail = email.trim()
    const separatorIndex = normalizedEmail.indexOf('@')
    if (separatorIndex <= 0) return undefined

    return { emailPrefix: normalizedEmail.slice(0, separatorIndex) }
  } catch {
    return undefined
  }
}

async function resolveRuntime(desktop, releaseChannel, platform) {
  const mappedPlatform = mapPlatform(platform)
  if (!mappedPlatform) return null

  try {
    const version = await desktop.app.getVersion()
    if (typeof version?.version !== 'string' || version.version === '') return null
    return {
      appVersion: version.version,
      platform: mappedPlatform,
      releaseChannel,
    }
  } catch {
    return null
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isSmartAppIdentity(value) {
  return (
    isRecord(value) &&
    isBoundedString(value.key) &&
    isBoundedString(value.name) &&
    isBoundedString(value.version) &&
    ['managed', 'linked', 'market'].includes(value.source)
  )
}

function mapPlatform(value) {
  if (value === 'darwin') return 'mac'
  if (value === 'win32') return 'win'
  if (value === 'linux') return 'linux'
  return null
}

function emptyQueueStatus() {
  return {
    queuedEvents: 0,
    droppedEvents: 0,
    sentBatches: 0,
    sentEvents: 0,
    retries: 0,
    permanentFailedBatches: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
  }
}
