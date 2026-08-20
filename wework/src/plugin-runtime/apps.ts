import { useSyncExternalStore } from 'react'

export interface WorkbenchAppContribution {
  key: string
  mode: 'native' | 'iframe'
  path?: string
  url?: string
  requiresAuth?: boolean
  hidden?: boolean
  hiddenInSwitcher?: boolean
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
  private revision = 0

  private emit(): void {
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
    return Array.from(this.apps.values())
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

export function getActiveWorkbenchAppRegistry(): WorkbenchAppRegistry {
  return activeRegistry
}

export function useActiveWorkbenchApps(): readonly WorkbenchAppContribution[] {
  const registry = getActiveWorkbenchAppRegistry()
  useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.version(),
    () => registry.version()
  )
  return registry.list()
}

export function setActiveWorkbenchAppRegistry(registry: WorkbenchAppRegistry): () => void {
  const previous = activeRegistry
  activeRegistry = registry
  return () => {
    if (activeRegistry === registry) {
      activeRegistry = previous
    }
  }
}
