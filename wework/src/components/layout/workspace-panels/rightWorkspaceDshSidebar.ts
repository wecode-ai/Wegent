export const WEWORK_WORKSPACE_SIDEBAR_TAB_EXTENSION_POINT = 'wework.workspace.sidebar.tab' as const

export interface WeworkWorkspaceScope {
  sessionId: string
  cwd?: string
}

export interface WeworkWorkspaceSidebarTab {
  id: string
  type: string
  title: string
  path?: string
  diff?: unknown
  meta?: unknown
}

export interface WeworkWorkspaceSidebarState {
  panelOpen: boolean
  tabs: readonly WeworkWorkspaceSidebarTab[]
  activeTabId: string | null
}

export interface WeworkWorkspaceSidebarSnapshot {
  sessionId?: string
  state?: WeworkWorkspaceSidebarState
}

export interface WeworkWorkspaceSidebarTabComponentProps {
  scope: WeworkWorkspaceScope
  tab: WeworkWorkspaceSidebarTab
  visible: boolean
}

export interface WeworkWorkspaceSidebarTabDescriptor {
  id: string
  title: string
  titleKey?: string
  mode?: 'component' | 'iframe'
  order?: number
  url?: string
  when?: {
    projectKinds?: readonly ('standard' | 'wework-core-dsh-plugin')[]
    codexPluginKeys?: readonly string[]
  }
}

export interface WeworkWorkspaceSidebarOpenTabSeed {
  type: string
  title?: string
  path?: string
  diff?: unknown
  id?: string
  url?: string
  meta?: unknown
}

export type RightWorkspaceExtensionTab = `dsh:${string}`

export function isRightWorkspaceExtensionTab(tab: string): tab is RightWorkspaceExtensionTab {
  return tab.startsWith('dsh:')
}

export interface RightWorkspaceExtensionTabState {
  internalId: RightWorkspaceExtensionTab
  tab: WeworkWorkspaceSidebarTab
}

interface RightWorkspaceSidebarController {
  active(): boolean
  openTab(seed: WeworkWorkspaceSidebarOpenTabSeed, scope?: WeworkWorkspaceScope): void
  closeTab(tabId: string, scope?: WeworkWorkspaceScope): void
  activateTab(tabId: string, scope?: WeworkWorkspaceScope): void
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  snapshot(): WeworkWorkspaceSidebarSnapshot
  subscribe(listener: () => void): () => void
}

export interface RightWorkspaceSidebarService {
  getTabs(): readonly WeworkWorkspaceSidebarTabDescriptor[]
  getTab(id: string): WeworkWorkspaceSidebarTabDescriptor | undefined
  isTabEnabled(id: string): boolean
  openTab(seed: WeworkWorkspaceSidebarOpenTabSeed, scope?: WeworkWorkspaceScope): void
  closeTab(tabId: string, scope?: WeworkWorkspaceScope): void
  activateTab(tabId: string, scope?: WeworkWorkspaceScope): void
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  getSnapshot(): WeworkWorkspaceSidebarSnapshot
  subscribe(listener: () => void): () => void
  subscribeState(listener: () => void): () => void
}

const stateListeners = new Set<() => void>()
const controllers = new Set<RightWorkspaceSidebarController>()
const EMPTY_SIDEBAR_TABS: readonly WeworkWorkspaceSidebarTabDescriptor[] = []
let cachedDshEntries: readonly { id: string; label?: string; order?: number }[] = []
let cachedDshTabs: readonly WeworkWorkspaceSidebarTabDescriptor[] = EMPTY_SIDEBAR_TABS

function targetController(scope?: WeworkWorkspaceScope) {
  const available = [...controllers].reverse()
  if (scope) {
    const targeted = available.find(
      controller => controller.snapshot().sessionId === scope.sessionId
    )
    if (targeted) return targeted
  }
  return available.find(controller => controller.active())
}

function notifyState() {
  for (const listener of [...stateListeners]) listener()
}

export function titleOfWeworkWorkspaceSidebarTab(
  descriptor: WeworkWorkspaceSidebarTabDescriptor,
  translate?: (key: string, fallback: string) => string
): string {
  if (descriptor.titleKey && translate) {
    return translate(descriptor.titleKey, descriptor.title)
  }
  return descriptor.title
}

export function isWeworkWorkspaceSidebarTabAvailable(
  descriptor: WeworkWorkspaceSidebarTabDescriptor,
  projectKind: 'standard' | 'wework-core-dsh-plugin' | 'unresolved',
  isPluginInstalled: (pluginKey: string) => boolean = () => true
): boolean {
  const projectKinds = descriptor.when?.projectKinds
  const codexPluginKeys = descriptor.when?.codexPluginKeys
  return (
    (!projectKinds?.length ||
      (projectKind !== 'unresolved' && projectKinds.includes(projectKind))) &&
    (!codexPluginKeys?.length || codexPluginKeys.every(isPluginInstalled))
  )
}

export function shouldCloseUnavailableWeworkWorkspaceSidebarTab(
  descriptor: WeworkWorkspaceSidebarTabDescriptor,
  projectKind: 'standard' | 'wework-core-dsh-plugin' | 'unresolved',
  available: boolean
): boolean {
  if (available) return false
  return projectKind !== 'unresolved' || !descriptor.when?.projectKinds?.length
}

export const rightWorkspaceDshSidebar: RightWorkspaceSidebarService = {
  getTabs() {
    const entries = getDshSlotEntries(WEWORK_DSH_SLOTS.workspaceSidebarTab)
    if (entries === cachedDshEntries) return cachedDshTabs
    cachedDshEntries = entries
    if (entries.length === 0) {
      cachedDshTabs = EMPTY_SIDEBAR_TABS
      return cachedDshTabs
    }
    cachedDshTabs = entries
      .filter(
        entry =>
          entry.mode !== 'iframe' || (typeof entry.url === 'string' && entry.url.trim().length > 0)
      )
      .map(entry => {
        const when =
          entry.when && typeof entry.when === 'object'
            ? (entry.when as {
                projectKinds?: unknown
                codexPluginKeys?: unknown
              })
            : null
        const projectKinds = Array.isArray(when?.projectKinds)
          ? (when.projectKinds as Array<'standard' | 'wework-core-dsh-plugin'>)
          : undefined
        const codexPluginKeys = Array.isArray(when?.codexPluginKeys)
          ? (when.codexPluginKeys as string[])
          : undefined
        const titleKey = typeof entry.labelKey === 'string' ? entry.labelKey : undefined
        const mode = entry.mode === 'iframe' ? 'iframe' : undefined
        const url = typeof entry.url === 'string' ? entry.url.trim() : undefined
        return {
          id: entry.id,
          title: entry.label ?? entry.id,
          titleKey,
          mode,
          order: entry.order,
          url,
          when:
            projectKinds || codexPluginKeys
              ? {
                  projectKinds,
                  codexPluginKeys,
                }
              : undefined,
        }
      })
    return cachedDshTabs
  },
  getTab(id) {
    return this.getTabs().find(tab => tab.id === id)
  },
  isTabEnabled(id) {
    return Boolean(this.getTab(id))
  },
  openTab(seed, scope) {
    targetController(scope)?.openTab(seed, scope)
  },
  closeTab(tabId, scope) {
    targetController(scope)?.closeTab(tabId, scope)
  },
  activateTab(tabId, scope) {
    targetController(scope)?.activateTab(tabId, scope)
  },
  updateTab(tabId, patch) {
    targetController()?.updateTab(tabId, patch)
  },
  getSnapshot() {
    return targetController()?.snapshot() ?? {}
  },
  subscribe(listener) {
    return subscribeDshSlot(WEWORK_DSH_SLOTS.workspaceSidebarTab, listener)
  },
  subscribeState(listener) {
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  },
}

export function attachRightWorkspaceSidebarController(
  controller: RightWorkspaceSidebarController
): () => void {
  controllers.add(controller)
  const unsubscribe = controller.subscribe(notifyState)
  notifyState()
  return () => {
    unsubscribe()
    controllers.delete(controller)
    notifyState()
  }
}

export function encodeRightWorkspaceExtensionTabId(tabId: string): RightWorkspaceExtensionTab {
  return `dsh:${encodeURIComponent(tabId)}`
}

export function resolveRightWorkspaceExtensionDescriptor(
  state: RightWorkspaceExtensionTabState | undefined
): WeworkWorkspaceSidebarTabDescriptor | undefined {
  return state ? rightWorkspaceDshSidebar.getTab(state.tab.type) : undefined
}

import {
  getDshSlotEntries,
  subscribeDshSlot,
  WEWORK_DSH_SLOTS,
} from '@/features/dsh-runtime/dshUiSlots'
