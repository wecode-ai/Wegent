import { createBatchQueue } from './batch-queue.js'
import { eventCatalog, INTERNAL_TELEMETRY_CATALOG_VERSION } from './catalog.js'
import { loadTelemetryConfig } from './config.js'
import { deriveDistinctId } from './identity.js'
import { createPostHogClient } from './posthog-client.js'
import { projectEnvelope } from './projection.js'

export const name = 'wework-internal-telemetry'
export const inject = ['weworkDesktop', 'weworkPluginRuntime']
export const TELEMETRY_SINK_PROTOCOL = 'telemetry-sink/v1'

const PLUGIN_VERSION = '0.1.0'

export async function apply(ctx) {
  await applyWithDependencies(ctx, {
    createBatchQueue,
    createPostHogClient,
    loadConfig: loadTelemetryConfig,
    platform: process.platform,
  })
}

export async function applyWithDependencies(
  ctx,
  {
    createBatchQueue: createQueue,
    createPostHogClient: createClient,
    loadConfig,
    logger = console,
    platform,
  }
) {
  const config = await loadConfig()
  const metrics = {
    projected: 0,
    received: 0,
    rejected: 0,
  }
  let active = true
  let enabled = config.public.enabled
  let error = config.public.error
  let queue = null
  let runtime = null

  if (enabled) {
    runtime = await resolveRuntime(ctx.weworkDesktop, config.public.releaseChannel, platform)
    if (!runtime) {
      enabled = false
      error = 'runtime_unavailable'
    }
  }

  if (enabled) {
    const client = createClient({
      host: config.private.posthogHost,
      projectKey: config.private.posthogProjectKey,
      timeoutMs: config.public.requestTimeoutMs,
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
      batchSize: config.public.batchSize,
      flushIntervalMs: config.public.flushIntervalMs,
      maxQueueSize: config.public.maxQueueSize,
      retryDelaysMs: [1000, 5000, 30000],
    })
  } else {
    logger?.warn?.('[wework-internal-telemetry] disabled', { code: error ?? 'disabled' })
  }

  ctx.weworkPluginRuntime.register(ctx, {
    id: name,
    methods: {
      ready: () => readyStatus(),
      accept: ({ envelope } = {}) => accept(envelope),
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

  function accept(envelope) {
    if (!active || !enabled || !queue || !runtime) {
      return { accepted: false, reason: 'disabled' }
    }

    metrics.received += 1
    let distinctId
    try {
      distinctId = deriveDistinctId(envelope?.context?.user, config.private.identityHmacKey)
    } catch {
      metrics.rejected += 1
      return { accepted: false, reason: 'identity_unavailable' }
    }

    let projected
    try {
      projected = projectEnvelope({
        catalog: eventCatalog,
        distinctId,
        envelope,
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
