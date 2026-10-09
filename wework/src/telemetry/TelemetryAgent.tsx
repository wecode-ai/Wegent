import type { WeworkDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { subscribeBusinessEvents } from './businessEvents'
import { useEffect, useMemo, useRef, useState } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { subscribeDesktopHostEvents, type DesktopHostEvent } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { useAuth } from '@/features/auth/useAuth'
import {
  getDshTelemetrySinks,
  subscribeDshTelemetrySinks,
} from '@/features/dsh-runtime/dshExtensions'
import { resolveRunningHarnessAppInstallation } from '@/features/harness-apps/harnessAppTabs'
import { trackEvent, useTelemetryEnabled } from './client'
import { getTelemetryConfig } from './config'
import { createTelemetryDispatcher } from './dispatcher'
import type { AnalyticsEvent, AnalyticsEventName } from './events'
import type {
  DomainTelemetryEvent,
  WeworkTelemetryContext,
  WeworkTelemetryFact,
  WeworkTelemetrySink,
} from './facts'
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

function internalSinks(): readonly WeworkTelemetrySink[] {
  return getDshTelemetrySinks().map(sink => ({
    accept: envelope => sink.accept(envelope as unknown as Readonly<Record<string, unknown>>),
    id: sink.id,
    protocol: sink.protocol,
  }))
}

function userContext(
  distribution: 'internal' | 'public',
  user: ReturnType<typeof useAuth>['user']
): WeworkTelemetryContext | undefined {
  if (distribution !== 'internal' || !user) return undefined
  return {
    user: {
      email: user.email,
      id: user.id,
      userName: user.user_name,
    },
  }
}

function routeContext(
  distribution: 'internal' | 'public',
  pathname: string,
  user: ReturnType<typeof useAuth>['user']
): WeworkTelemetryContext | undefined {
  const context = userContext(distribution, user)
  if (distribution !== 'internal' || !pathname.startsWith('/app/')) return context
  const installation = resolveRunningHarnessAppInstallation(
    decodeURIComponent(pathname.slice('/app/'.length))
  )
  if (!installation) return context
  return {
    ...context,
    smartApp: {
      key: installation.manifest.name,
      name: installation.manifest.displayName,
      source: installation.source,
      version: installation.manifest.version,
    },
  }
}

function fact(
  event: import('./events').AnalyticsEvent,
  context?: WeworkTelemetryContext
): WeworkTelemetryFact {
  return {
    ...event,
    context,
    occurredAt: new Date().toISOString(),
  }
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
  const { pathname, search } = useTelemetryLocation()
  const routes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const feature = routes.find(route => route.path === pathname)?.telemetryFeature
  const distribution = getTelemetryConfig().distribution
  const publicTelemetryEnabled = useTelemetryEnabled()
  const electronRuntime = isElectronRuntime()
  const lastRouteKeyRef = useRef<string | null>(null)
  const pendingDesktopStartupEventsRef = useRef<DesktopStartupAnalyticsEvent[]>([])
  const publicTelemetryEnabledRef = useRef(publicTelemetryEnabled)
  const seenDesktopStartupEventsRef = useRef(new Set<string>())
  const dispatcher = useMemo(
    () =>
      createTelemetryDispatcher({
        distribution,
        internalSinks,
        publicSink: distribution === 'public' ? { accept: trackEvent, id: 'public' } : null,
      }),
    [distribution]
  )

  useEffect(() => {
    publicTelemetryEnabledRef.current = publicTelemetryEnabled
  }, [publicTelemetryEnabled])

  useEffect(
    () =>
      subscribeBusinessEvents(event => {
        const context =
          distribution === 'internal'
            ? { ...userContext(distribution, user), ...event.context }
            : undefined
        dispatcher.publish({
          ...event,
          context,
          occurredAt: new Date().toISOString(),
        })
      }),
    [dispatcher, distribution, user]
  )

  useEffect(() => subscribeDshTelemetrySinks(() => dispatcher.flushInternalSinks()), [dispatcher])

  useEffect(
    () =>
      subscribeOperationResults(result => {
        const context =
          distribution === 'internal'
            ? { ...userContext(distribution, user), ...result.context }
            : undefined
        dispatcher.publish(fact(operationEvent(result), context))
      }),
    [dispatcher, distribution, user]
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
        if (distribution === 'public' && !publicTelemetryEnabledRef.current) {
          pendingDesktopStartupEventsRef.current.push(event)
          return
        }
        dispatcher.publish(fact(event, userContext(distribution, user)))
      },
      { replay: hostEvent => desktopStartupEvent(hostEvent) !== null }
    )
  }, [dispatcher, distribution, electronRuntime, user])

  useEffect(() => {
    if (distribution !== 'public' || !publicTelemetryEnabled) return
    const pending = pendingDesktopStartupEventsRef.current
    pendingDesktopStartupEventsRef.current = []
    for (const event of pending) dispatcher.publish(fact(event))
  }, [dispatcher, distribution, publicTelemetryEnabled])

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
    if (distribution === 'public' && !publicTelemetryEnabled) return

    lastRouteKeyRef.current = routeKey
    dispatcher.publish(fact(event, routeContext(distribution, pathname, user)))
  }, [dispatcher, distribution, feature, isLoading, pathname, publicTelemetryEnabled, search, user])

  return null
}
