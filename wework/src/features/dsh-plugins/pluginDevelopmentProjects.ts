import {
  observePluginDevelopmentProject,
  type PluginDevelopmentProjectClassification,
} from './pluginDevelopment'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

export type PluginDevelopmentProjectKind =
  | PluginDevelopmentProjectClassification['kind']
  | 'unresolved'

const classifications = new Map<string, PluginDevelopmentProjectClassification>()
const listeners = new Set<() => void>()
let observedRoot: string | null = null
let revision = 0

function publish(classification: PluginDevelopmentProjectClassification | null) {
  if (classification) classifications.set(classification.sourceRoot, classification)
  revision += 1
  for (const listener of [...listeners]) listener()
}

export function observePluginDevelopmentWorkspace(sourceRoot: string | null): () => void {
  if (!isElectronRuntime()) return () => undefined
  const normalized = sourceRoot?.trim() || null
  observedRoot = normalized
  void observePluginDevelopmentProject(normalized)
    .then(classification => {
      if (observedRoot === normalized) publish(classification)
    })
    .catch(error => {
      console.error('[Wework] Failed to classify plugin development project', error)
    })
  return () => {
    if (observedRoot !== normalized) return
    observedRoot = null
    void observePluginDevelopmentProject(null).catch(() => {})
  }
}

export function pluginDevelopmentProjectKind(
  sourceRoot: string | null | undefined
): PluginDevelopmentProjectKind {
  const normalized = sourceRoot?.trim()
  if (!normalized) return 'standard'
  return classifications.get(normalized)?.kind ?? 'unresolved'
}

export function subscribePluginDevelopmentProjects(listener: () => void): () => void {
  listeners.add(listener)
  if (!isElectronRuntime()) {
    return () => {
      listeners.delete(listener)
    }
  }
  const unsubscribeEvents = subscribeDesktopHostEvents(event => {
    if (event.type !== 'plugin-development.project-classification') return
    publish(event.payload as unknown as PluginDevelopmentProjectClassification)
  })
  return () => {
    listeners.delete(listener)
    unsubscribeEvents()
  }
}

export function pluginDevelopmentProjectsRevision(): number {
  return revision
}
