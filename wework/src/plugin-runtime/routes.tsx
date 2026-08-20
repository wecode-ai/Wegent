import { useSyncExternalStore, type ReactNode } from 'react'

import type { AnalyticsEventMap } from '@/telemetry/events'

type WorkbenchTelemetryFeature = AnalyticsEventMap['feature_opened']['feature']

export interface WorkbenchRouteRenderContext {
  search: string
}

export interface WorkbenchRouteContribution {
  id: string
  path: string
  telemetryFeature: WorkbenchTelemetryFeature
  render: (context: WorkbenchRouteRenderContext) => ReactNode
}

export class WorkbenchRouteRegistry {
  private readonly routes = new Map<string, WorkbenchRouteContribution>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  register(route: WorkbenchRouteContribution): () => void {
    if (this.routes.has(route.path)) {
      throw new Error(`Workbench route '${route.path}' is already registered`)
    }
    this.routes.set(route.path, route)
    this.emit()
    return () => {
      if (this.routes.get(route.path) === route) {
        this.routes.delete(route.path)
        this.emit()
      }
    }
  }

  resolve(path: string): WorkbenchRouteContribution | null {
    return this.routes.get(path) ?? null
  }

  list(): readonly WorkbenchRouteContribution[] {
    return Array.from(this.routes.values())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  version(): number {
    return this.revision
  }
}

export function useWorkbenchRouteRegistry(
  registry: WorkbenchRouteRegistry
): WorkbenchRouteRegistry {
  useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.version(),
    () => registry.version()
  )
  return registry
}
