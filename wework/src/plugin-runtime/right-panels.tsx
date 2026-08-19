import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'

export interface WorkbenchRightPanelContribution {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  render: () => ReactNode
}

export class WorkbenchRightPanelRegistry {
  private readonly contributions = new Map<string, WorkbenchRightPanelContribution>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly WorkbenchRightPanelContribution[] = []
  private revision = 0

  private emit(): void {
    this.snapshot = Array.from(this.contributions.values())
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  register(contribution: WorkbenchRightPanelContribution): () => void {
    if (this.contributions.has(contribution.key)) {
      throw new Error(`Workbench right panel '${contribution.key}' is already registered`)
    }
    this.contributions.set(contribution.key, contribution)
    this.emit()
    return () => {
      if (this.contributions.get(contribution.key) === contribution) {
        this.contributions.delete(contribution.key)
        this.emit()
      }
    }
  }

  resolve(key: string): WorkbenchRightPanelContribution | null {
    return this.contributions.get(key) ?? null
  }

  list(): readonly WorkbenchRightPanelContribution[] {
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

let activeRegistry = new WorkbenchRightPanelRegistry()
const activeRegistryListeners = new Set<() => void>()
let activeRegistryRevision = 0
let unsubscribeActiveRegistry = activeRegistry.subscribe(notifyActiveRegistryListeners)

function notifyActiveRegistryListeners(): void {
  for (const listener of activeRegistryListeners) listener()
}

function replaceActiveRegistry(registry: WorkbenchRightPanelRegistry): void {
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

export function useActiveWorkbenchRightPanels(): readonly WorkbenchRightPanelContribution[] {
  useSyncExternalStore(
    subscribeActiveRegistry,
    getActiveRegistrySnapshot,
    getActiveRegistrySnapshot
  )
  return activeRegistry.list()
}

export function setActiveWorkbenchRightPanelRegistry(
  registry: WorkbenchRightPanelRegistry
): () => void {
  const previous = activeRegistry
  replaceActiveRegistry(registry)
  return () => {
    if (activeRegistry === registry) {
      replaceActiveRegistry(previous)
    }
  }
}
