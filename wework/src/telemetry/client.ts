import { useSyncExternalStore } from 'react'
import type { CaptureResult, PostHog } from 'posthog-js'
import { telemetryPolicy } from '@extensions/telemetry-policy'
import type { TelemetryIdentity } from '@extensions/telemetry-policy-contract'
import {
  ANALYTICS_EVENT_PROPERTY_KEYS,
  ANALYTICS_EVENT_VALUE_CONSTRAINTS,
  type AnalyticsEvent,
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
// The account this installation last reported, kept outside the SDK so a
// restart can tell "the SDK still holds an account" from "this install has
// never been identified".
const IDENTIFIED_ACCOUNT_KEY = 'wework.telemetry.identified-account.v1'
const STAND_IN_COLLECTION_SINCE_KEY = 'wework.stand-in-telemetry-enabled-since'
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
// posthog-js emits its own identity events: `$identify` links the stored
// anonymous id to the signed-in account and `$set` updates person properties.
// They are not product events, so the catalog allowlist below would drop them;
// they pass only while the active policy installs person profiles, which is
// also what makes PostHog create the profile.
const IDENTITY_CAPTURE_EVENTS = new Set(['$identify', '$set'])
const IDENTITY_CAPTURE_PROPERTY_KEYS = [
  ...POSTHOG_TRANSPORT_PROPERTY_KEYS,
  // Names the anonymous person that `$identify` merges into the account.
  '$anon_distinct_id',
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
let identity: TelemetryIdentity | null = null
// Set once the app tells us which account this session belongs to, including
// `null` for "no account". Until then the SDK's persisted account is left alone
// so a restart does not rotate the identity of a signed-in user.
let identityResolved = false

function readIdentifiedAccount(): string | null {
  try {
    return localStorage.getItem(IDENTIFIED_ACCOUNT_KEY)
  } catch {
    return null
  }
}

function writeIdentifiedAccount(distinctId: string): void {
  try {
    localStorage.setItem(IDENTIFIED_ACCOUNT_KEY, distinctId)
  } catch {
    // Telemetry keeps working without remembering the account locally.
  }
}

function clearIdentifiedAccount(): void {
  try {
    localStorage.removeItem(IDENTIFIED_ACCOUNT_KEY)
  } catch {
    // Telemetry keeps working without remembering the account locally.
  }
}

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

function sanitizeIdentityCapture(capture: CaptureResult): CaptureResult {
  const allowedPropertyKeys = new Set<string>(IDENTITY_CAPTURE_PROPERTY_KEYS)
  const sanitized: CaptureResult = {
    event: capture.event,
    properties: Object.fromEntries(
      Object.entries(capture.properties).filter(([key]) => allowedPropertyKeys.has(key))
    ),
    timestamp: capture.timestamp,
    uuid: capture.uuid,
  }
  // Person properties live outside `properties`. Only the properties the
  // distribution policy named may be stored: posthog-js merges its own
  // `$set_once` payload (`$initial_current_url`, `$initial_pathname`,
  // `$initial_referrer_info`, ...) before `before_send`, and forwarding it would
  // upload page URLs and any credentials they carry.
  const policyPropertyKeys = new Set(Object.keys(identity?.properties ?? {}))
  const personProperties = Object.fromEntries(
    Object.entries(capture.$set ?? {}).filter(([key]) => policyPropertyKeys.has(key))
  )
  if (Object.keys(personProperties).length > 0) sanitized.$set = personProperties
  return sanitized
}

function sanitizePostHogCapture(capture: CaptureResult | null): CaptureResult | null {
  if (!capture) return null
  if (telemetryPolicy.personProfiles !== 'never' && IDENTITY_CAPTURE_EVENTS.has(capture.event)) {
    return sanitizeIdentityCapture(capture)
  }
  if (!Object.prototype.hasOwnProperty.call(ANALYTICS_EVENT_PROPERTY_KEYS, capture.event)) {
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

/**
 * Reconciles the account this session reports with whatever the SDK persisted
 * on a previous run. A different account must not inherit the previous person,
 * and an anonymous session must not keep reporting an account from the last
 * run; a never-identified installation keeps its anonymous id untouched.
 */
function applyIdentityToClient(client: PostHog, nextIdentity: TelemetryIdentity | null): void {
  const previousDistinctId = readIdentifiedAccount()
  if (!nextIdentity) {
    if (!previousDistinctId) return
    client.reset(true)
    clearIdentifiedAccount()
    return
  }
  if (previousDistinctId && previousDistinctId !== nextIdentity.distinctId) {
    client.reset(true)
  }
  client.identify(nextIdentity.distinctId, nextIdentity.properties)
  writeIdentifiedAccount(nextIdentity.distinctId)
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
    advanced_disable_flags: true,
    opt_out_persistence_by_default: true,
    persistence: 'localStorage',
    person_profiles: telemetryPolicy.personProfiles,
    // Batch sends so each capture does not immediately run the full
    // send pipeline (compression, persistence, request) on the caller's stack.
    request_batching: true,
    before_send: sanitizePostHogCapture,
  })
  // Leave a persisted account alone until the app tells us which account this
  // session belongs to; applying it here would rotate the identity of a
  // signed-in user on every restart.
  if (identityResolved) applyIdentityToClient(posthog, identity)
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
      (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'localhost'
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
  })
  return initializing
}

function flushPendingCaptures(): void {
  captureFlushScheduled = false
  if (!posthog || !enabled) return
  const pending = pendingCaptures
  pendingCaptures = []
  for (const event of pending) {
    try {
      posthog.capture(event.name, event.properties)
    } catch {
      // Telemetry SDK failures must not surface as unhandled application errors
      // or prevent later events in the same batch from being attempted.
    }
  }
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
  updateStandInCollectionBoundary(initiallyEnabled)
  setTelemetryEnabledFlag(initiallyEnabled)
  if (!enabled) return
  await initialize()
  posthog?.opt_in_capturing()
  flushQueuedEvents()
}

/**
 * Attaches the signed-in account to PostHog when the distribution policy
 * provides one, and detaches it on sign-out. Anonymous policies always pass
 * `null`; that also clears an account the SDK restored from a previous run, so
 * events are never attributed to a user who is no longer signed in.
 */
export function applyTelemetryIdentity(nextIdentity: TelemetryIdentity | null): void {
  if (!enabled) return
  identityResolved = true
  identity = nextIdentity
  if (!posthog) return
  applyIdentityToClient(posthog, nextIdentity)
}

export function track<EventName extends AnalyticsEventName>(
  name: EventName,
  properties: AnalyticsEventMap[EventName]
): void {
  if (!enabled) return
  const allowedProperties = sanitizeAnalyticsProperties(name, properties)
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

export function trackEvent(event: AnalyticsEvent): void {
  track(event.name, event.properties)
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
  updateStandInCollectionBoundary(nextEnabled)
  if (enabled === nextEnabled) return
  setTelemetryEnabledFlag(nextEnabled)
  if (nextEnabled) {
    await initialize()
    posthog?.opt_in_capturing()
    flushQueuedEvents()
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
  identity = null
  identityResolved = false
  posthog = null
  sentry = null
  localStorage.removeItem(INSTALLATION_ID_KEY)
  clearIdentifiedAccount()
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
  identity = null
  identityResolved = false
  clearIdentifiedAccount()
}

export function sanitizeAnalyticsProperties<EventName extends AnalyticsEventName>(
  name: EventName,
  properties: AnalyticsEventMap[EventName]
): AnalyticsEventMap[EventName] {
  const valueConstraints = ANALYTICS_EVENT_VALUE_CONSTRAINTS[name]
  return ANALYTICS_EVENT_PROPERTY_KEYS[name].reduce(
    (acc, key) => {
      const value = properties[key]
      if (value === undefined) return acc
      const constraint = valueConstraints?.[key]
      if (constraint) {
        if (Array.isArray(constraint)) {
          if (!constraint.includes(value as never)) return acc
        } else if ('min' in constraint || 'max' in constraint) {
          if (typeof value !== 'number' || !Number.isFinite(value)) return acc
          if (constraint.min != null && value < constraint.min) return acc
          if (constraint.max != null && value > constraint.max) return acc
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
}

export interface DurablePublicIdentity {
  readonly distinctId: string
  readonly common: CommonTelemetryProperties
}

export async function durablePublicIdentity(): Promise<DurablePublicIdentity | null> {
  if (!enabled) return null
  await initialize()
  if (!enabled || !posthog) return null
  return { distinctId: posthog.get_distinct_id(), common: { ...commonTelemetryProperties() } }
}

/** Keep the durable queue until the SDK transport confirms HTTP acceptance. */
export async function deliverDurablePublicEvent(
  event: AnalyticsEvent,
  id: string,
  occurredAt: string,
  identity: DurablePublicIdentity
): Promise<boolean> {
  if (!enabled) return false
  await initialize()
  const sdk = posthog
  if (!enabled || !sdk || sdk.get_distinct_id() !== identity.distinctId) return false
  const timestamp = new Date(occurredAt)
  const properties = sdk.calculateEventProperties(
    event.name,
    {
      ...identity.common,
      ...sanitizeAnalyticsProperties(event.name, event.properties),
      distinct_id: identity.distinctId,
      token: getTelemetryConfig().posthogKey,
      $geoip_disable: true,
      $process_person_profile: false,
    },
    timestamp,
    id,
    true
  )
  const payload = sanitizePostHogCapture({ event: event.name, properties, uuid: id, timestamp })
  if (!payload) return false
  return new Promise(resolve => {
    // The SDK capture API only confirms enqueueing in its in-memory queue.
    // Use its existing transport with a receipt; our durable queue owns retries.
    const timer = setTimeout(() => resolve(false), 11_000)
    try {
      sdk._send_request({
        url: sdk.requestRouter.endpointFor('api', sdk.analyticsDefaultEndpoint),
        data: payload,
        method: 'POST',
        transport: 'fetch',
        timeout: 10_000,
        noRetries: true,
        fireCallbackOnDrop: true,
        callback: response => {
          clearTimeout(timer)
          resolve(response.statusCode >= 200 && response.statusCode < 300)
        },
      })
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

function updateStandInCollectionBoundary(allow: boolean) {
  if (allow) {
    if (!localStorage.getItem(STAND_IN_COLLECTION_SINCE_KEY))
      localStorage.setItem(STAND_IN_COLLECTION_SINCE_KEY, String(Date.now()))
    return
  }
  localStorage.removeItem(STAND_IN_COLLECTION_SINCE_KEY)
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('wework.stand-in-telemetry:public:')) localStorage.removeItem(key)
  }
}

export function standInCollectionSince(): number | undefined {
  const raw = localStorage.getItem(STAND_IN_COLLECTION_SINCE_KEY)
  const value = raw == null ? NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}
