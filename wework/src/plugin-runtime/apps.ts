import { useSyncExternalStore } from 'react'

export interface WorkbenchAppContribution {
  key: string
  mode: 'native' | 'iframe'
  path?: string
  url?: string
  requiresAuth?: boolean
  hidden?: boolean
  experimental?: boolean
  requiresCloud?: boolean
  labelKey: string
  label: string
  descriptionKey: string
  description: string
}

export class WorkbenchAppRegistry {
  private readonly apps = new Map<string, WorkbenchAppContribution>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly WorkbenchAppContribution[] = []
  private revision = 0

  private emit(): void {
    this.snapshot = Array.from(this.apps.values())
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  register(app: WorkbenchAppContribution): () => void {
    if (this.apps.has(app.key)) {
      throw new Error(`Workbench app '${app.key}' is already registered`)
    }
    this.apps.set(app.key, app)
    this.emit()
    return () => {
      if (this.apps.get(app.key) === app) {
        this.apps.delete(app.key)
        this.emit()
      }
    }
  }

  resolve(key: string): WorkbenchAppContribution | null {
    return this.apps.get(key) ?? null
  }

  list(): readonly WorkbenchAppContribution[] {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  version(): number {
    return this.revision
  }
}

let activeRegistry = new WorkbenchAppRegistry()
const activeRegistryListeners = new Set<() => void>()
let activeRegistryRevision = 0
let unsubscribeActiveRegistry = activeRegistry.subscribe(notifyActiveRegistryListeners)

function notifyActiveRegistryListeners(): void {
  for (const listener of activeRegistryListeners) listener()
}

function replaceActiveRegistry(registry: WorkbenchAppRegistry): void {
  unsubscribeActiveRegistry()
  activeRegistry = registry
  unsubscribeActiveRegistry = registry.subscribe(notifyActiveRegistryListeners)
  activeRegistryRevision += 1
  notifyActiveRegistryListeners()
}

function subscribeActiveRegistry(listener: () => void): () => void {
  activeRegistryListeners.add(listener)
  return () => activeRegistryListeners.delete(listener)
}

function getActiveRegistrySnapshot(): string {
  return `${activeRegistryRevision}:${activeRegistry.version()}`
}

export function getActiveWorkbenchAppRegistry(): WorkbenchAppRegistry {
  return activeRegistry
}

export function useActiveWorkbenchApps(): readonly WorkbenchAppContribution[] {
  useSyncExternalStore(
    subscribeActiveRegistry,
    getActiveRegistrySnapshot,
    getActiveRegistrySnapshot
  )
  return activeRegistry.list()
}

export function setActiveWorkbenchAppRegistry(registry: WorkbenchAppRegistry): () => void {
  const previous = activeRegistry
  replaceActiveRegistry(registry)
  return () => {
    if (activeRegistry === registry) {
      replaceActiveRegistry(previous)
    }
  }
}
