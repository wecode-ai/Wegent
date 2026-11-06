import type { WeworkDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import {
  getDshTelemetrySinks,
  subscribeDshTelemetrySinks,
} from '@/features/dsh-runtime/dshExtensions'
import { subscribeBusinessEvents } from './businessEvents'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { subscribeDesktopHostEvents, type DesktopHostEvent } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { getTelemetryConfig } from './config'
import { setTelemetryUser } from './identity'
import { useAuth } from '@/features/auth/useAuth'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { trackEvent, useTelemetryEnabled } from './client'
import { createTelemetryDispatcher } from './dispatcher'
import type { AnalyticsEvent, AnalyticsEventName } from './events'
import type { DomainTelemetryEvent, WeworkTelemetryFact, WeworkTelemetrySink } from './facts'
import type { OperationResult } from './operationBus'
import { subscribeOperationResults } from './operationBus'
import { resolveTelemetryRoute } from './routeRegistry'

interface LocationState {
  readonly pathname: string
  readonly search: string
}

type DesktopStartupAnalyticsEvent = Extract<
  AnalyticsEvent,
  {
    name: Extract<AnalyticsEventName, `app_startup_${string}`>
  }
>

function currentLocation(): LocationState {
  return {
    pathname: stripAppBasePath(window.location.pathname),
    search: window.location.search,
  }
}

function useTelemetryLocation(): LocationState {
  const [location, setLocation] = useState(currentLocation)

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return location
}

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

export function TelemetryAgent() {
  const { isLoading, user } = useAuth()
  const cloud = useContext(CloudConnectionContext)
  const telemetryUser = cloud?.user ?? user
  const telemetryUserRef = useRef<typeof telemetryUser | undefined>(telemetryUser)
  useLayoutEffect(() => {
    telemetryUserRef.current = telemetryUser
    setTelemetryUser(telemetryUser)
    return () => {
      telemetryUserRef.current = undefined
      setTelemetryUser(null)
    }
  }, [telemetryUser])
  const appPreferences = useAppPreferencesState()
  const { pathname, search } = useTelemetryLocation()
  const routes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const feature = routes.find(route => route.path === pathname)?.telemetryFeature
  const telemetryEnabled = useTelemetryEnabled()
  const telemetryExplicitlyDisabled =
    appPreferences?.loaded === true &&
    appPreferences.preferences.telemetryConsentAsked === true &&
    appPreferences.preferences.telemetryEnabled !== true
  const electronRuntime = isElectronRuntime()
  const lastRouteKeyRef = useRef<string | null>(null)
  const pendingDesktopStartupEventsRef = useRef<DesktopStartupAnalyticsEvent[]>([])
  const telemetryExplicitlyDisabledRef = useRef(telemetryExplicitlyDisabled)
  const telemetryEnabledRef = useRef(telemetryEnabled)
  const seenDesktopStartupEventsRef = useRef(new Set<string>())
  const dispatcher = useMemo(
    () =>
      createTelemetryDispatcher(trackEvent, {
        internalSinks,
        isInternalDeliveryEnabled: () => telemetryEnabled && !telemetryExplicitlyDisabled,
      }),
    [telemetryEnabled, telemetryExplicitlyDisabled]
  )

  useEffect(() => {
    telemetryEnabledRef.current = telemetryEnabled
    telemetryExplicitlyDisabledRef.current = telemetryExplicitlyDisabled
    if (telemetryExplicitlyDisabled) {
      pendingDesktopStartupEventsRef.current = []
    }
    if (telemetryEnabled && !telemetryExplicitlyDisabled) dispatcher.flushInternalSinks()
  }, [dispatcher, telemetryEnabled, telemetryExplicitlyDisabled])

  useEffect(() => subscribeDshTelemetrySinks(() => dispatcher.flushInternalSinks()), [dispatcher])

  useEffect(
    () =>
      subscribeBusinessEvents(event => {
        dispatcher.publish(fact(event, event.context))
      }),
    [dispatcher]
  )

  useEffect(
    () =>
      subscribeOperationResults(result => {
        dispatcher.publish(fact(operationEvent(result), result.context))
      }),
    [dispatcher]
  )

  useEffect(() => {
    if (!electronRuntime) return
    return subscribeDesktopHostEvents(
      hostEvent => {
        const event = desktopStartupEvent(hostEvent)
        if (!event) return
        const eventKey = `${event.name}:${event.properties.startup_id}`
        if (seenDesktopStartupEventsRef.current.has(eventKey)) return
        seenDesktopStartupEventsRef.current.add(eventKey)
        if (telemetryExplicitlyDisabledRef.current) return
        if (!telemetryEnabledRef.current) {
          pendingDesktopStartupEventsRef.current.push(event)
          return
        }
        dispatcher.publish(fact(event))
      },
      { replay: hostEvent => desktopStartupEvent(hostEvent) !== null }
    )
  }, [dispatcher, electronRuntime])

  useEffect(() => {
    if (!telemetryEnabled) return
    const pending = pendingDesktopStartupEventsRef.current
    pendingDesktopStartupEventsRef.current = []
    for (const event of pending) dispatcher.publish(fact(event))
  }, [dispatcher, telemetryEnabled])

  useEffect(() => {
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
      lastRouteKeyRef.current = null
      return
    }
    if (lastRouteKeyRef.current === routeKey) return
    if (!telemetryEnabled) return

    lastRouteKeyRef.current = routeKey
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
    const observedUser = telemetryUserRef.current
    void harnessAppsApi
      .list()
      .then(installations => {
        const installation = installations.find(item => item.id === installationId)
        if (!telemetryEnabledRef.current || telemetryUserRef.current !== observedUser) return
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
        if (telemetryEnabledRef.current && telemetryUserRef.current === observedUser)
          dispatcher.publish(routeFact)
      })
  }, [dispatcher, feature, isLoading, pathname, telemetryEnabled, search])

  return null
}
