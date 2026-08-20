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
  private revision = 0

  private emit(): void {
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
    return Array.from(this.contributions.values())
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

export function getActiveWorkbenchSettingsRegistry(): WorkbenchSettingsRegistry {
  return activeRegistry
}

export function useActiveWorkbenchSettings(): readonly WorkbenchSettingsContribution[] {
  const registry = getActiveWorkbenchSettingsRegistry()
  useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.version(),
    () => registry.version()
  )
  return registry.list()
}

export function setActiveWorkbenchSettingsRegistry(
  registry: WorkbenchSettingsRegistry
): () => void {
  const previous = activeRegistry
  activeRegistry = registry
  return () => {
    if (activeRegistry === registry) {
      activeRegistry = previous
    }
  }
}
