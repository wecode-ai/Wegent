import { useSyncExternalStore } from 'react'
import type { CaptureResult, PostHog } from 'posthog-js'
import {
  ANALYTICS_EVENT_PROPERTY_KEYS,
  ANALYTICS_EVENT_VALUE_CONSTRAINTS,
  type AnalyticsEventMap,
  type AnalyticsEventName,
  type CommonTelemetryProperties,
  type QueuedAnalyticsEvent,
} from './events'
import {
  getCommonTelemetryProperties,
  getTelemetryConfig,
  resetTelemetrySessionId,
  telemetrySessionId,
} from './config'

const INSTALLATION_ID_KEY = 'wework.telemetry.installation-id.v1'
const MAX_QUEUED_EVENTS = 100
const COMMON_EVENT_PROPERTY_KEYS = [
  'app_version',
  'arch',
  'locale',
  'os',
  'release_channel',
  'runtime_mode',
  'telemetry_session_id',
] as const
const POSTHOG_TRANSPORT_PROPERTY_KEYS = [
  '$device_id',
  '$geoip_disable',
  '$lib',
  '$lib_version',
  '$process_person_profile',
  '$session_id',
  '$window_id',
  'distinct_id',
  'token',
] as const

type SentryModule = typeof import('@sentry/react')
type SentryEvent = Parameters<NonNullable<Parameters<SentryModule['init']>[0]['beforeSend']>>[0]
type SentryTransaction = Parameters<
  NonNullable<Parameters<SentryModule['init']>[0]['beforeSendTransaction']>
>[0]
type SentrySpan = Parameters<NonNullable<Parameters<SentryModule['init']>[0]['beforeSendSpan']>>[0]
type SentryExceptionValue = NonNullable<NonNullable<SentryEvent['exception']>['values']>[number]
type SentryFrame = NonNullable<NonNullable<SentryExceptionValue['stacktrace']>['frames']>[number]

let enabled = false
let initialized = false
let initializing: Promise<void> | null = null
let posthog: PostHog | null = null
let sentry: SentryModule | null = null
let queuedEvents: QueuedAnalyticsEvent[] = []
let pendingCaptures: QueuedAnalyticsEvent[] = []
let captureFlushScheduled = false
let cachedCommonProperties: CommonTelemetryProperties | null = null
let pendingTransition: Promise<void> = Promise.resolve()

const telemetryEnabledListeners = new Set<() => void>()

function setTelemetryEnabledFlag(next: boolean): void {
  if (enabled === next) return
  enabled = next
  for (const listener of telemetryEnabledListeners) listener()
}

function installationId(): string {
  const stored = localStorage.getItem(INSTALLATION_ID_KEY)
  if (stored) return stored
  const created = crypto.randomUUID()
  localStorage.setItem(INSTALLATION_ID_KEY, created)
  return created
}

// Common properties are identical for every event in a session (the session id
// only changes when telemetry is re-enabled), so derive them once instead of
// re-reading runtime config and sessionStorage on every track() call.
function commonTelemetryProperties(): CommonTelemetryProperties {
  cachedCommonProperties ??= getCommonTelemetryProperties()
  return cachedCommonProperties
}

function sanitizePostHogCapture(capture: CaptureResult | null): CaptureResult | null {
  if (
    !capture ||
    !Object.prototype.hasOwnProperty.call(ANALYTICS_EVENT_PROPERTY_KEYS, capture.event)
  ) {
    return null
  }
  const eventName = capture.event as AnalyticsEventName
  const allowedPropertyKeys = new Set<string>([
    ...COMMON_EVENT_PROPERTY_KEYS,
    ...POSTHOG_TRANSPORT_PROPERTY_KEYS,
    ...ANALYTICS_EVENT_PROPERTY_KEYS[eventName],
  ])
  const sanitized: CaptureResult = {
    event: capture.event,
    properties: Object.fromEntries(
      Object.entries(capture.properties).filter(([key]) => allowedPropertyKeys.has(key))
    ),
    timestamp: capture.timestamp,
    uuid: capture.uuid,
  }
  return sanitized
}

async function initPostHog(): Promise<void> {
  if (posthog) return
  const config = getTelemetryConfig()
  if (!config.posthogKey) return
  const module = await import('posthog-js')
  posthog = module.default.init(config.posthogKey, {
    api_host: config.posthogHost,
    autocapture: false,
    capture_pageleave: false,
    capture_pageview: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_external_dependency_loading: true,
    disable_compression: import.meta.env.VITE_WEWORK_E2E === 'true',
    disableDeviceModel: true,
    disable_session_recording: true,
    advanced_disable_feature_flags: true,
    opt_out_persistence_by_default: true,
    persistence: 'localStorage',
    person_profiles: 'never',
    // Batch sends so each capture does not immediately run the full
    // send pipeline (compression, persistence, request) on the caller's stack.
    request_batching: true,
    before_send: sanitizePostHogCapture,
  })
}

function sanitizeSentryTags(tags: SentryEvent['tags']): SentryEvent['tags'] {
  const allowedKeys = new Set(['installation_id', 'release_channel', 'telemetry_session_id'])
  return Object.fromEntries(Object.entries(tags ?? {}).filter(([key]) => allowedKeys.has(key)))
}

const SENTRY_DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRUSTED_SENTRY_APP_PATHS = new Set([
  '/',
  '/extension-page.html',
  '/index.html',
  '/runtime-config.js',
])
const TRUSTED_SENTRY_APP_PATH_PREFIXES = ['/@vite/', '/assets/', '/node_modules/', '/src/'] as const

function isTrustedSentryAppPath(pathname: string): boolean {
  return (
    TRUSTED_SENTRY_APP_PATHS.has(pathname) ||
    TRUSTED_SENTRY_APP_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix))
  )
}

function sanitizeSentryResourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const relativeBase = 'wework-relative://localhost'
    const url = new URL(value, relativeBase)
    const isRelativeAppPath = url.protocol === 'wework-relative:' && url.hostname === 'localhost'
    const isProductionAppUrl =
      (url.protocol === 'tauri:' && url.hostname === 'localhost') ||
      ((url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname === 'tauri.localhost')
    const isDevelopmentAppUrl =
      url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '1420'
    if (
      (!isRelativeAppPath && !isProductionAppUrl && !isDevelopmentAppUrl) ||
      !isTrustedSentryAppPath(url.pathname)
    ) {
      return undefined
    }
    if (isRelativeAppPath) {
      return value.startsWith('/') ? url.pathname : url.pathname.slice(1)
    }
    // Reconstruct the URL without credentials, query, or fragment.
    return new URL(`${url.protocol}//${url.host}${url.pathname}`).toString()
  } catch {
    return undefined
  }
}

function sanitizeSentryFrame(frame: SentryFrame): SentryFrame {
  const filename = sanitizeSentryResourceUrl(frame.filename)
  const absPath = sanitizeSentryResourceUrl(frame.abs_path)
  const trustedResource = absPath ?? filename
  return {
    abs_path: absPath,
    colno: frame.colno,
    debug_id:
      trustedResource && frame.debug_id && SENTRY_DEBUG_ID_PATTERN.test(frame.debug_id)
        ? frame.debug_id
        : undefined,
    filename: trustedResource ? filename : frame.filename ? '<redacted>' : undefined,
    function: frame.function,
    in_app: frame.in_app,
    lineno: frame.lineno,
    module: trustedResource ? frame.module : undefined,
  }
}

function sanitizeSentryDebugMeta(debugMeta: SentryEvent['debug_meta']): SentryEvent['debug_meta'] {
  const images = debugMeta?.images?.flatMap(image => {
    if (image.type !== 'sourcemap' || !SENTRY_DEBUG_ID_PATTERN.test(image.debug_id)) return []
    const codeFile = sanitizeSentryResourceUrl(image.code_file)
    return codeFile
      ? [
          {
            code_file: codeFile,
            debug_id: image.debug_id,
            type: 'sourcemap' as const,
          },
        ]
      : []
  })
  return images?.length ? { images } : undefined
}

function sanitizeSentrySpan(span: SentrySpan): SentrySpan {
  return {
    data: {},
    op: span.op,
    origin: span.origin,
    parent_span_id: span.parent_span_id,
    span_id: span.span_id,
    start_timestamp: span.start_timestamp,
    status: span.status,
    timestamp: span.timestamp,
    trace_id: span.trace_id,
  }
}

function sanitizeSentryEvent(event: SentryEvent): SentryEvent {
  return {
    debug_meta: sanitizeSentryDebugMeta(event.debug_meta),
    environment: event.environment,
    event_id: event.event_id,
    exception: event.exception?.values
      ? {
          values: event.exception.values.map(value => ({
            mechanism: value.mechanism
              ? {
                  handled: value.mechanism.handled,
                  synthetic: value.mechanism.synthetic,
                  type: value.mechanism.type,
                }
              : undefined,
            stacktrace: value.stacktrace
              ? {
                  frames: value.stacktrace.frames?.map(sanitizeSentryFrame),
                }
              : undefined,
            type: 'Error',
            value: 'Wework error',
          })),
        }
      : undefined,
    level: event.level,
    platform: event.platform,
    release: event.release,
    tags: sanitizeSentryTags(event.tags),
    timestamp: event.timestamp,
    type: undefined,
  }
}

function sanitizeSentryTransaction(event: SentryTransaction): SentryTransaction {
  const trace = event.contexts?.trace
  return {
    contexts: trace
      ? {
          trace: {
            op: trace.op,
            origin: trace.origin,
            parent_span_id: trace.parent_span_id,
            span_id: trace.span_id,
            status: trace.status,
            trace_id: trace.trace_id,
          },
        }
      : undefined,
    environment: event.environment,
    event_id: event.event_id,
    platform: event.platform,
    release: event.release,
    spans: event.spans?.map(sanitizeSentrySpan),
    start_timestamp: event.start_timestamp,
    tags: sanitizeSentryTags(event.tags),
    timestamp: event.timestamp,
    transaction: 'Wework transaction',
    type: 'transaction',
  }
}

async function initSentry(): Promise<void> {
  if (sentry) return
  const config = getTelemetryConfig()
  if (!config.sentryDsn) return
  sentry = await import('@sentry/react')
  sentry.init({
    dsn: config.sentryDsn,
    environment: config.environment,
    release: `wework@${__WEWORK_APP_VERSION__}`,
    sendDefaultPii: false,
    tracesSampleRate: config.sentryTracesSampleRate,
    integrations: [sentry.browserTracingIntegration()],
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryTransaction,
    beforeSendSpan: sanitizeSentrySpan,
  })
  sentry.setTag('release_channel', config.releaseChannel)
  sentry.setTag('installation_id', installationId())
  sentry.setTag('telemetry_session_id', telemetrySessionId())
}

async function initialize(): Promise<void> {
  if (initialized || initializing) return initializing ?? Promise.resolve()
  initializing = Promise.allSettled([initPostHog(), initSentry()]).then(() => {
    initialized = true
    initializing = null
    flushQueuedEvents()
  })
  return initializing
}

function flushPendingCaptures(): void {
  captureFlushScheduled = false
  if (!posthog || !enabled) return
  const pending = pendingCaptures
  pendingCaptures = []
  for (const event of pending) posthog.capture(event.name, event.properties)
}

// Defers the synchronous capture pipeline (before_send sanitization, event
// compression, localStorage persistence) off the caller's stack so tracking
// calls made inside stream handlers and React effects do not block rendering
// and input handling. Events from the same turn are coalesced into one flush.
function schedulePostHogCapture(event: QueuedAnalyticsEvent): void {
  pendingCaptures.push(event)
  if (captureFlushScheduled) return
  captureFlushScheduled = true
  queueMicrotask(flushPendingCaptures)
}

function flushQueuedEvents(): void {
  if (!posthog || !enabled) return
  const pending = queuedEvents
  queuedEvents = []
  for (const event of pending) schedulePostHogCapture(event)
}

if (typeof window !== 'undefined') {
  // Send anything still queued when the window closes so a trace is not left
  // open; deferred microtasks are not guaranteed to run on unload.
  window.addEventListener('pagehide', flushPendingCaptures)
}

export function isTelemetryEnabled(): boolean {
  return enabled
}

export function subscribeTelemetryEnabled(listener: () => void): () => void {
  telemetryEnabledListeners.add(listener)
  return () => {
    telemetryEnabledListeners.delete(listener)
  }
}

export function useTelemetryEnabled(): boolean {
  return useSyncExternalStore(subscribeTelemetryEnabled, isTelemetryEnabled)
}

export async function installTelemetry(initiallyEnabled: boolean): Promise<void> {
  setTelemetryEnabledFlag(initiallyEnabled)
  if (!enabled) return
  await initialize()
}

export function track<EventName extends AnalyticsEventName>(
  name: EventName,
  properties: AnalyticsEventMap[EventName]
): void {
  if (!enabled) return
  const valueConstraints = ANALYTICS_EVENT_VALUE_CONSTRAINTS[name]
  const allowedProperties = ANALYTICS_EVENT_PROPERTY_KEYS[name].reduce(
    (acc, key) => {
      const value = properties[key]
      if (value === undefined) return acc
      const constraint = valueConstraints?.[key]
      if (constraint) {
        if (Array.isArray(constraint)) {
          if (!constraint.includes(value as never)) return acc
        } else if ('pattern' in constraint || 'maxLength' in constraint) {
          if (constraint.enum && !constraint.enum.includes(value as never)) return acc
          if (typeof value === 'string') {
            if (constraint.maxLength != null && value.length > constraint.maxLength) return acc
            if (constraint.pattern && !constraint.pattern.test(value)) return acc
          }
        }
      }
      return { ...acc, [key]: value }
    },
    {} as AnalyticsEventMap[EventName]
  )
  const event: QueuedAnalyticsEvent<EventName> = {
    name,
    properties: { ...commonTelemetryProperties(), ...allowedProperties },
  }
  if (posthog) {
    schedulePostHogCapture(event)
    return
  }
  queuedEvents = [...queuedEvents.slice(-(MAX_QUEUED_EVENTS - 1)), event]
  void initialize()
}

export function captureError(error: unknown): void {
  if (!enabled) return
  if (sentry) {
    sentry.captureException(error)
    return
  }
  void initialize().then(() => sentry?.captureException(error))
}

export function setTelemetryEnabled(nextEnabled: boolean): Promise<void> {
  const transition = pendingTransition.then(() => applyTelemetryEnabled(nextEnabled))
  pendingTransition = transition.catch(() => undefined)
  return transition
}

async function applyTelemetryEnabled(nextEnabled: boolean): Promise<void> {
  if (enabled === nextEnabled) return
  setTelemetryEnabledFlag(nextEnabled)
  if (nextEnabled) {
    await initialize()
    posthog?.opt_in_capturing()
    track('telemetry_preference_changed', { enabled: true })
    return
  }
  queuedEvents = []
  pendingCaptures = []
  captureFlushScheduled = false
  cachedCommonProperties = null
  if (initializing) {
    await initializing
    initializing = null
  }
  posthog?.reset(true)
  posthog?.opt_out_capturing()
  sentry?.setUser(null)
  await sentry?.close(0)
  posthog = null
  sentry = null
  localStorage.removeItem(INSTALLATION_ID_KEY)
  resetTelemetrySessionId()
  initialized = false
}

export function resetTelemetryForTests(): void {
  setTelemetryEnabledFlag(false)
  pendingTransition = Promise.resolve()
  initialized = false
  initializing = null
  posthog = null
  sentry = null
  queuedEvents = []
  pendingCaptures = []
  captureFlushScheduled = false
  cachedCommonProperties = null
}
