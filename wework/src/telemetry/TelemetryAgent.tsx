import type { WeworkDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { subscribeBusinessEvents } from './businessEvents'
import { useEffect, useMemo, useRef, useState } from 'react'
import { stripAppBasePath } from '@/config/runtime'
import { useAuth } from '@/features/auth/useAuth'
import {
  getDshTelemetrySinks,
  subscribeDshTelemetrySinks,
} from '@/features/dsh-runtime/dshExtensions'
import { resolveRunningHarnessAppInstallation } from '@/features/harness-apps/harnessAppTabs'
import { trackEvent, useTelemetryEnabled } from './client'
import { getTelemetryConfig } from './config'
import { createTelemetryDispatcher } from './dispatcher'
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
          properties: { domain, failure_stage: result.failureStage! as never },
        }
      : { name, properties: { domain } }
  ) as DomainTelemetryEvent
}

export function TelemetryAgent() {
  const { isLoading, user } = useAuth()
  const { pathname, search } = useTelemetryLocation()
  const routes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const feature = routes.find(route => route.path === pathname)?.telemetryFeature
  const distribution = getTelemetryConfig().distribution
  const publicTelemetryEnabled = useTelemetryEnabled()
  const lastRouteKeyRef = useRef<string | null>(null)
  const dispatcher = useMemo(
    () =>
      createTelemetryDispatcher({
        distribution,
        internalSinks,
        publicSink: distribution === 'public' ? { accept: trackEvent, id: 'public' } : null,
      }),
    [distribution]
  )

  useEffect(
    () =>
      subscribeBusinessEvents(event => {
        dispatcher.publish({
          ...event,
          context: userContext(distribution, user),
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
