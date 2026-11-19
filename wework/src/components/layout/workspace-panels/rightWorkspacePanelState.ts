import {
  observePluginDevelopmentWorkspace,
  pluginDevelopmentProjectKind,
  subscribePluginDevelopmentProjects,
  type PluginDevelopmentProjectKind,
} from '@/features/dsh-plugins/pluginDevelopmentProjects'
import {
  getComposerApps,
  subscribeComposerApps,
} from '@/components/chat/composer/composerAppsSnapshot'
import {
  isRightWorkspaceExtensionTab,
  isWeworkWorkspaceSidebarTabAvailable,
  resolveRightWorkspaceExtensionDescriptor,
  rightWorkspaceDshSidebar,
  shouldCloseUnavailableWeworkWorkspaceSidebarTab,
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
  type WeworkWorkspaceSidebarTabDescriptor,
} from './rightWorkspaceDshSidebar'

interface ExtensionCatalogSnapshot {
  availableTabs: WeworkWorkspaceSidebarTabDescriptor[]
  projectKind: PluginDevelopmentProjectKind
}

interface ExtensionObserver {
  listener: () => void
  openTabs: readonly string[]
  extensionTabs: Partial<Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>>
  onCloseTab: (tab: RightWorkspaceExtensionTab) => void
  closedTabs: Set<RightWorkspaceExtensionTab>
}

/** Availability and project classification share the same scoped, observed catalog. */
export function createRightWorkspaceExtensionCatalog(cwd: string | null) {
  const observers = new Set<ExtensionObserver>()
  let snapshot: ExtensionCatalogSnapshot | undefined
  let stopSources: (() => void) | null = null
  let stopWorkspace: (() => void) | null = null
  let startQueued = false
  function getSnapshot(): ExtensionCatalogSnapshot {
    const projectKind = pluginDevelopmentProjectKind(cwd)
    const apps = getComposerApps()
    const availableTabs = rightWorkspaceDshSidebar
      .getTabs()
      .filter(descriptor =>
        isWeworkWorkspaceSidebarTabAvailable(descriptor, projectKind, pluginKey =>
          apps.some(app => app.pluginKey === pluginKey)
        )
      )
    if (
      !snapshot ||
      snapshot.projectKind !== projectKind ||
      snapshot.availableTabs.length !== availableTabs.length ||
      snapshot.availableTabs.some((descriptor, index) => descriptor !== availableTabs[index])
    ) {
      snapshot = { availableTabs, projectKind }
    }
    return snapshot
  }
  function reconcile(observer: ExtensionObserver) {
    const current = getSnapshot()
    const availableIds = new Set(current.availableTabs.map(descriptor => descriptor.id))
    for (const tab of observer.openTabs) {
      if (!observers.has(observer)) return
      if (!isRightWorkspaceExtensionTab(tab)) continue
      const descriptor = resolveRightWorkspaceExtensionDescriptor(observer.extensionTabs[tab])
      const unavailable =
        descriptor &&
        shouldCloseUnavailableWeworkWorkspaceSidebarTab(
          descriptor,
          current.projectKind,
          availableIds.has(descriptor.id)
        )
      if (!unavailable) {
        observer.closedTabs.delete(tab)
        continue
      }
      if (observer.closedTabs.has(tab)) continue
      observer.closedTabs.add(tab)
      observer.onCloseTab(tab)
    }
  }
  function publish() {
    getSnapshot()
    for (const observer of [...observers]) {
      if (!observers.has(observer)) continue
      observer.listener()
      reconcile(observer)
    }
  }
  function start() {
    if (stopSources) return
    const stops = [
      rightWorkspaceDshSidebar.subscribe(publish),
      subscribePluginDevelopmentProjects(publish),
      subscribeComposerApps(publish),
    ]
    stopSources = () => stops.forEach(stop => stop())
    // Rebinding callback metadata does not restart project classification I/O.
    if (startQueued) return
    startQueued = true
    queueMicrotask(() => {
      startQueued = false
      if (observers.size === 0 || stopWorkspace) return
      stopWorkspace = observePluginDevelopmentWorkspace(cwd)
    })
  }
  return {
    getSnapshot,
    subscribe(listener: () => void, metadata: Omit<ExtensionObserver, 'listener' | 'closedTabs'>) {
      const observer: ExtensionObserver = { ...metadata, listener, closedTabs: new Set() }
      observers.add(observer)
      start()
      reconcile(observer)
      return () => {
        // Invalidate this observer immediately, even if the catalog is reused this commit.
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size > 0) return
          stopSources?.()
          stopSources = null
          stopWorkspace?.()
          stopWorkspace = null
        })
      }
    },
  }
}
