import type { ReactNode } from 'react'

export interface DshBetterSidebarScope {
  sessionId: string
  cwd?: string
}

export interface DshBetterSidebarTab {
  id: string
  type: string
  title: string
  path?: string
  diff?: unknown
  meta?: unknown
}

export interface DshBetterSidebarState {
  panelOpen: boolean
  tabs: readonly DshBetterSidebarTab[]
  activeTabId: string | null
}

export interface DshBetterSidebarSnapshot {
  sessionId?: string
  state?: DshBetterSidebarState
}

export interface DshBetterSidebarTabComponentProps {
  ctx: DshBetterSidebarContext
  store: DshBetterSidebarService
  scope: DshBetterSidebarScope
  tab: DshBetterSidebarTab
  visible: boolean
}

export interface DshBetterSidebarTabDescriptor {
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number
  hidden?: boolean
  available?: (
    ctx: DshBetterSidebarContext,
    scope: DshBetterSidebarScope,
    state: DshBetterSidebarState
  ) => boolean
  single?: boolean
  dedupeKey?: (tab: DshBetterSidebarTab) => string | undefined
  createTab?: (
    state: DshBetterSidebarState
  ) => { tab: DshBetterSidebarTab; patch?: Partial<DshBetterSidebarState> } | null
  badge?: (
    ctx: DshBetterSidebarContext,
    scope: DshBetterSidebarScope,
    state: DshBetterSidebarState
  ) => string | number | null | undefined
  onOpen?: (tab: DshBetterSidebarTab, scope: DshBetterSidebarScope) => void
  onActivate?: (tab: DshBetterSidebarTab, scope: DshBetterSidebarScope) => void
  onClose?: (tab: DshBetterSidebarTab, scope: DshBetterSidebarScope) => void
  component: (props: DshBetterSidebarTabComponentProps) => ReactNode
}

export interface DshBetterSidebarOpenTabSeed {
  type: string
  title?: string
  path?: string
  diff?: unknown
  id?: string
  url?: string
  meta?: unknown
}

export interface DshBetterSidebarContext {
  betterSidebar: DshBetterSidebarService
  [service: string]: unknown
}

export type RightWorkspaceExtensionTab = `dsh:${string}`

export function isRightWorkspaceExtensionTab(tab: string): tab is RightWorkspaceExtensionTab {
  return tab.startsWith('dsh:')
}

export interface RightWorkspaceExtensionTabState {
  internalId: RightWorkspaceExtensionTab
  tab: DshBetterSidebarTab
}

interface RightWorkspaceSidebarController {
  active(): boolean
  openTab(seed: DshBetterSidebarOpenTabSeed, scope?: DshBetterSidebarScope): void
  closeTab(tabId: string, scope?: DshBetterSidebarScope): void
  activateTab(tabId: string, scope?: DshBetterSidebarScope): void
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  snapshot(): DshBetterSidebarSnapshot
  subscribe(listener: () => void): () => void
}

export interface DshBetterSidebarService {
  readonly version: string
  readonly features: readonly string[]
  registerTab(descriptor: DshBetterSidebarTabDescriptor): () => void
  getTabs(): readonly DshBetterSidebarTabDescriptor[]
  getTab(id: string): DshBetterSidebarTabDescriptor | undefined
  isTabEnabled(id: string): boolean
  openTab(seed: DshBetterSidebarOpenTabSeed, scope?: DshBetterSidebarScope): void
  closeTab(tabId: string, scope?: DshBetterSidebarScope): void
  activateTab(tabId: string, scope?: DshBetterSidebarScope): void
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  getSnapshot(): DshBetterSidebarSnapshot
  subscribe(listener: () => void): () => void
  subscribeState(listener: () => void): () => void
}

const SERVICE_VERSION = '0.15.2-wework.1'
const SERVICE_FEATURES = [
  'badge',
  'tabLifecycle',
  'updateTab',
  'targetedOpen',
  'stateSubscription',
  'tabMeta',
] as const

const descriptors = new Map<string, DshBetterSidebarTabDescriptor>()
const registryListeners = new Set<() => void>()
const stateListeners = new Set<() => void>()
const controllers = new Set<RightWorkspaceSidebarController>()
let descriptorSnapshot: readonly DshBetterSidebarTabDescriptor[] = []

function notifyRegistry() {
  descriptorSnapshot = [...descriptors.values()]
  for (const listener of [...registryListeners]) listener()
}

function targetController(scope?: DshBetterSidebarScope) {
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

function reportPluginError(stage: string, error: unknown) {
  console.error(`[Wework better-sidebar] ${stage} failed:`, error)
}

export function titleOfDshBetterSidebarTab(descriptor: DshBetterSidebarTabDescriptor): string {
  try {
    return typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
  } catch (error) {
    reportPluginError(`title "${descriptor.id}"`, error)
    return descriptor.id
  }
}

export function isDshBetterSidebarTabAvailable(
  descriptor: DshBetterSidebarTabDescriptor,
  scope: DshBetterSidebarScope,
  state: DshBetterSidebarState
): boolean {
  if (!descriptor.available) return true
  try {
    return descriptor.available(rightWorkspaceBetterSidebarContext, scope, state)
  } catch (error) {
    reportPluginError(`available "${descriptor.id}"`, error)
    return false
  }
}

export function invokeDshBetterSidebarLifecycle(
  descriptor: DshBetterSidebarTabDescriptor,
  stage: 'onOpen' | 'onActivate' | 'onClose',
  tab: DshBetterSidebarTab,
  scope: DshBetterSidebarScope
) {
  try {
    descriptor[stage]?.(tab, scope)
  } catch (error) {
    reportPluginError(`${stage} "${descriptor.id}"`, error)
  }
}

export const rightWorkspaceBetterSidebar: DshBetterSidebarService = {
  version: SERVICE_VERSION,
  features: SERVICE_FEATURES,
  registerTab(descriptor) {
    if (!descriptor.id.trim()) {
      throw new Error('[Wework better-sidebar] tab id is required')
    }
    if (descriptors.has(descriptor.id)) {
      throw new Error(`[Wework better-sidebar] tab type "${descriptor.id}" already registered`)
    }
    descriptors.set(descriptor.id, descriptor)
    notifyRegistry()
    return () => {
      if (descriptors.get(descriptor.id) !== descriptor) return
      for (const controller of controllers) {
        for (const tab of controller.snapshot().state?.tabs ?? []) {
          if (tab.type === descriptor.id) controller.closeTab(tab.id)
        }
      }
      descriptors.delete(descriptor.id)
      notifyRegistry()
    }
  },
  getTabs() {
    return descriptorSnapshot
  },
  getTab(id) {
    return descriptors.get(id)
  },
  isTabEnabled(id) {
    return descriptors.has(id)
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
    registryListeners.add(listener)
    return () => registryListeners.delete(listener)
  },
  subscribeState(listener) {
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  },
}

export const rightWorkspaceBetterSidebarContext: DshBetterSidebarContext = {
  betterSidebar: rightWorkspaceBetterSidebar,
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
): DshBetterSidebarTabDescriptor | undefined {
  return state ? descriptors.get(state.tab.type) : undefined
}

declare global {
  interface Window {
    __WEWORK_DSH_BETTER_SIDEBAR__?: DshBetterSidebarService
  }
}

if (typeof window !== 'undefined') {
  window.__WEWORK_DSH_BETTER_SIDEBAR__ = rightWorkspaceBetterSidebar
}
