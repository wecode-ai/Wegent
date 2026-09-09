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
  SmartAppTelemetryEvent,
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
  event: SmartAppTelemetryEvent,
  context?: WeworkTelemetryContext
): WeworkTelemetryFact {
  return {
    ...event,
    context,
    occurredAt: new Date().toISOString(),
  }
}

function operationEvent(result: OperationResult): SmartAppTelemetryEvent {
  const action = result.key.slice('smart_app.'.length)
  const name = `smart_app_${action}_${result.outcome}` as SmartAppTelemetryEvent['name']
  return (
    result.outcome === 'failed'
      ? {
          name,
          properties: { domain: 'smart_app', failure_stage: result.failureStage! as never },
        }
      : { name, properties: { domain: 'smart_app' } }
  ) as SmartAppTelemetryEvent
}

export function TelemetryAgent() {
  const { isLoading, user } = useAuth()
  const { pathname, search } = useTelemetryLocation()
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
    const event = resolveTelemetryRoute(pathname, search)
    if (!event) {
      lastRouteKeyRef.current = routeKey
      return
    }
    if (lastRouteKeyRef.current === routeKey) return
    if (distribution === 'public' && !publicTelemetryEnabled) return

    lastRouteKeyRef.current = routeKey
    dispatcher.publish(fact(event, routeContext(distribution, pathname, user)))
  }, [dispatcher, distribution, isLoading, pathname, publicTelemetryEnabled, search, user])

  return null
}
