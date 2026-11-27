import {
  getDshTelemetrySinks,
  subscribeDshTelemetrySinks,
} from '@/features/dsh-runtime/dshExtensions'
import { subscribeDesktopHostEvents, type DesktopHostEvent } from '@/api/dsh/desktopHost'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { subscribeBusinessEvents } from './businessEvents'
import { getTelemetryConfig } from './config'
import { setTelemetryUser } from './identity'
import { trackEvent } from './client'
import { createTelemetryDispatcher } from './dispatcher'
import type { AnalyticsEvent, AnalyticsEventName } from './events'
import type { DomainTelemetryEvent, WeworkTelemetryFact, WeworkTelemetrySink } from './facts'
import type { OperationResult } from './operationBus'
import { subscribeOperationResults } from './operationBus'
import { resolveTelemetryRoute } from './routeRegistry'
type DesktopStartupAnalyticsEvent = Extract<
  AnalyticsEvent,
  {
    name: Extract<AnalyticsEventName, `app_startup_${string}`>
  }
>

function fact(
  event: AnalyticsEvent,
  context?: WeworkTelemetryFact['context']
): WeworkTelemetryFact {
  return { ...event, ...(context ? { context } : {}), occurredAt: new Date().toISOString() }
}

function internalSinks(): readonly WeworkTelemetrySink[] {
  return getDshTelemetrySinks().map(sink => ({
    id: sink.id,
    protocol: sink.protocol,
    accept: envelope => sink.accept(envelope as unknown as Readonly<Record<string, unknown>>),
  }))
}

function operationEvent(result: OperationResult): DomainTelemetryEvent {
  const [domain, action] = result.key.split('.')
  const name = `${domain}_${action}_${result.outcome}` as DomainTelemetryEvent['name']
  return (
    result.outcome === 'failed'
      ? {
          name,
          properties: {
            ...result.properties,
            domain,
            failure_stage: result.failureStage! as never,
          },
        }
      : { name, properties: { ...result.properties, domain } }
  ) as DomainTelemetryEvent
}

function desktopStartupEvent(event: DesktopHostEvent): DesktopStartupAnalyticsEvent | null {
  const startupId = event.payload.startup_id
  if (typeof startupId !== 'string') return null
  if (event.type === 'startup.attempted') {
    return {
      name: 'app_startup_attempted',
      properties: { startup_id: startupId },
    }
  }

  const durationMs = event.payload.duration_ms
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null
  if (event.type === 'startup.succeeded') {
    return {
      name: 'app_startup_succeeded',
      properties: { duration_ms: durationMs, startup_id: startupId },
    }
  }
  if (event.type !== 'startup.failed') return null
  const failureStage = event.payload.failure_stage
  if (
    failureStage !== 'core_plugin' &&
    failureStage !== 'desktop_runtime' &&
    failureStage !== 'renderer_initialize' &&
    failureStage !== 'renderer_load' &&
    failureStage !== 'unknown'
  ) {
    return null
  }
  return {
    name: 'app_startup_failed',
    properties: {
      duration_ms: durationMs,
      failure_stage: failureStage,
      startup_id: startupId,
    },
  }
}

export interface TelemetrySessionInput {
  user: Parameters<typeof setTelemetryUser>[0]
  isLoading: boolean
  enabled: boolean
  explicitlyDisabled: boolean
  electronRuntime: boolean
  pathname: string
  search: string
  feature?: string
}
let identityOwner: object | undefined

/** Analytics listens only while its actual window owner is observed. */
export function createTelemetrySession() {
  let input: TelemetrySessionInput | undefined
  let lastRouteKey: string | null = null
  let pending: DesktopStartupAnalyticsEvent[] = []
  const seen = new Set<string>()
  let releases: Array<() => void> = []
  let releaseHost: (() => void) | undefined
  let active = false
  const owner = {}
  const makeDispatcher = () =>
    createTelemetryDispatcher(trackEvent, {
      internalSinks,
      isInternalDeliveryEnabled: () => active && !!input?.enabled && !input.explicitlyDisabled,
    })
  let dispatcher = makeDispatcher()
  const trackRoute = () => {
    const { isLoading, pathname, search, feature, enabled: telemetryEnabled } = input!
    if (isLoading) return
    const routeKey = `${pathname}${search}`
    const event =
      resolveTelemetryRoute(pathname, search) ??
      (feature === 'plugins' || feature === 'plugin_management'
        ? {
            name: 'plugin_center_opened' as const,
            properties: {
              surface: feature === 'plugins' ? ('catalog' as const) : ('management' as const),
            },
          }
        : null)
    if (!event) {
      lastRouteKey = null
      return
    }
    if (lastRouteKey === routeKey) return
    if (!telemetryEnabled) return

    lastRouteKey = routeKey
    const routeFact = fact(event)
    const collectAppContext = getTelemetryConfig().contextFields.some(field =>
      field.startsWith('smart_app_')
    )
    if (event.name !== 'smart_app_opened' || !collectAppContext) {
      dispatcher.publish(routeFact)
      return
    }
    // A restored app route can precede its runtime/tab cache registration.
    // Read the installation catalog, which also contains stopped applications.
    const installationId = decodeURIComponent(pathname.slice('/app/harness-'.length))
    const observedUser = input?.user
    void harnessAppsApi
      .list()
      .then(installations => {
        const installation = installations.find(item => item.id === installationId)
        if (input?.explicitlyDisabled || !input?.enabled || input?.user !== observedUser) return
        dispatcher.publish({
          ...routeFact,
          ...(installation
            ? {
                context: {
                  smartApp: {
                    key: installation.manifest.name,
                    name: installation.manifest.displayName,
                    source: installation.source,
                    version: installation.manifest.version,
                  },
                },
              }
            : {}),
        })
      })
      .catch(() => {
        console.warn('[Wework telemetry] App metadata unavailable')
        if (!input?.explicitlyDisabled && input?.enabled && input?.user === observedUser)
          dispatcher.publish(routeFact)
      })
  }
  const synchronizeHost = () => {
    if (!input?.electronRuntime || !active) {
      releaseHost?.()
      releaseHost = undefined
      return
    }
    if (releaseHost) return
    releaseHost = subscribeDesktopHostEvents(
      hostEvent => {
        const event = desktopStartupEvent(hostEvent)
        if (!event) return
        const key = event.name + ':' + event.properties.startup_id
        if (seen.has(key)) return
        seen.add(key)
        if (input?.explicitlyDisabled) return
        if (!input?.enabled) pending.push(event)
        else dispatcher.publish(fact(event))
      },
      { replay: event => desktopStartupEvent(event) !== null }
    )
  }
  return {
    update(next: TelemetrySessionInput) {
      const previous = input
      input = next
      const policyChanged =
        previous?.enabled !== next.enabled ||
        previous?.explicitlyDisabled !== next.explicitlyDisabled
      if (policyChanged) dispatcher = makeDispatcher()
      if (!active) {
        active = true
        releases = [
          subscribeDshTelemetrySinks(() => dispatcher.flushInternalSinks()),
          subscribeBusinessEvents(event => dispatcher.publish(fact(event, event.context))),
          subscribeOperationResults(result =>
            dispatcher.publish(fact(operationEvent(result), result.context))
          ),
        ]
      }
      identityOwner = owner
      setTelemetryUser(next.user)
      if (next.explicitlyDisabled) pending = []
      synchronizeHost()
      if (next.enabled && !next.explicitlyDisabled) {
        dispatcher.flushInternalSinks()
        const queue = pending
        pending = []
        for (const event of queue) dispatcher.publish(fact(event))
      }
      trackRoute()
    },
    stop() {
      active = false
      input = undefined
      for (const release of releases) release()
      releases = []
      releaseHost?.()
      releaseHost = undefined
      if (identityOwner === owner) {
        identityOwner = undefined
        setTelemetryUser(null)
      }
    },
  }
}
