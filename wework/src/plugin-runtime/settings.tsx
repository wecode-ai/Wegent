import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'

import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'

export interface WorkbenchSettingsRenderContext {
  services?: WorkbenchServices
  devices: DeviceInfo[]
  onBack: () => void
  onOpenCloudSettings: () => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: () => Promise<void>
}

export interface WorkbenchSettingsContribution {
  key: string
  path: string
  aliases?: readonly string[]
  icon: ComponentType<{ className?: string }>
  labelKey: string
  label: string
  category: string
  categoryLabelKey: string
  categoryLabel: string
  experimental?: boolean
  desktopOnly?: boolean
  render?: (context: WorkbenchSettingsRenderContext) => ReactNode
}

export class WorkbenchSettingsRegistry {
  private readonly contributions = new Map<string, WorkbenchSettingsContribution>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly WorkbenchSettingsContribution[] = []
  private revision = 0

  private emit(): void {
    this.snapshot = Array.from(this.contributions.values())
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  register(contribution: WorkbenchSettingsContribution): () => void {
    if (this.contributions.has(contribution.key)) {
      throw new Error(`Workbench settings contribution '${contribution.key}' is already registered`)
    }
    const paths = new Set([contribution.path, ...(contribution.aliases ?? [])])
    if (
      this.list().some(existing =>
        [existing.path, ...(existing.aliases ?? [])].some(path => paths.has(path))
      )
    ) {
      throw new Error(`Workbench settings path '${contribution.path}' is already registered`)
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

  resolve(key: string): WorkbenchSettingsContribution | null {
    return this.contributions.get(key) ?? null
  }

  resolvePath(path: string): WorkbenchSettingsContribution | null {
    return (
      this.list().find(
        contribution => contribution.path === path || contribution.aliases?.includes(path)
      ) ?? null
    )
  }

  list(): readonly WorkbenchSettingsContribution[] {
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

let activeRegistry = new WorkbenchSettingsRegistry()
const activeRegistryListeners = new Set<() => void>()
let activeRegistryRevision = 0
let unsubscribeActiveRegistry = activeRegistry.subscribe(notifyActiveRegistryListeners)

function notifyActiveRegistryListeners(): void {
  for (const listener of activeRegistryListeners) listener()
}

function replaceActiveRegistry(registry: WorkbenchSettingsRegistry): void {
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

export function getActiveWorkbenchSettingsRegistry(): WorkbenchSettingsRegistry {
  return activeRegistry
}

export function useActiveWorkbenchSettings(): readonly WorkbenchSettingsContribution[] {
  useSyncExternalStore(
    subscribeActiveRegistry,
    getActiveRegistrySnapshot,
    getActiveRegistrySnapshot
  )
  return activeRegistry.list()
}

export function setActiveWorkbenchSettingsRegistry(
  registry: WorkbenchSettingsRegistry
): () => void {
  const previous = activeRegistry
  replaceActiveRegistry(registry)
  return () => {
    if (activeRegistry === registry) {
      replaceActiveRegistry(previous)
    }
  }
}
