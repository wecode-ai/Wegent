import type { ReactNode } from 'react'

export const WEWORK_WORKSPACE_SIDEBAR_TAB_EXTENSION_POINT = 'wework.workspace.sidebar.tab' as const

export type WeworkExtensionPoint = typeof WEWORK_WORKSPACE_SIDEBAR_TAB_EXTENSION_POINT

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
  ctx: WeworkExtensionContext
  store: DshBetterSidebarService
  scope: WeworkWorkspaceScope
  tab: WeworkWorkspaceSidebarTab
  visible: boolean
}

export interface WeworkWorkspaceSidebarTabDescriptor {
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number
  hidden?: boolean
  available?: (
    ctx: WeworkExtensionContext,
    scope: WeworkWorkspaceScope,
    state: WeworkWorkspaceSidebarState
  ) => boolean
  single?: boolean
  dedupeKey?: (tab: WeworkWorkspaceSidebarTab) => string | undefined
  createTab?: (state: WeworkWorkspaceSidebarState) => {
    tab: WeworkWorkspaceSidebarTab
    patch?: Partial<WeworkWorkspaceSidebarState>
  } | null
  badge?: (
    ctx: WeworkExtensionContext,
    scope: WeworkWorkspaceScope,
    state: WeworkWorkspaceSidebarState
  ) => string | number | null | undefined
  onOpen?: (tab: WeworkWorkspaceSidebarTab, scope: WeworkWorkspaceScope) => void
  onActivate?: (tab: WeworkWorkspaceSidebarTab, scope: WeworkWorkspaceScope) => void
  onClose?: (tab: WeworkWorkspaceSidebarTab, scope: WeworkWorkspaceScope) => void
  component?: (props: WeworkWorkspaceSidebarTabComponentProps) => ReactNode
  mount?: (
    container: HTMLElement,
    props: WeworkWorkspaceSidebarTabComponentProps
  ) => {
    update(props: WeworkWorkspaceSidebarTabComponentProps): void
    dispose(): void
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

export interface WeworkExtensionContext {
  wework: WeworkHostService
  betterSidebar: DshBetterSidebarService
  [service: string]: unknown
}

export interface WeworkExtensionRegistry {
  readonly protocol: 'wework.extensions.v1'
  readonly version: string
  readonly extensionPoints: readonly WeworkExtensionPoint[]
  register(
    extensionPoint: typeof WEWORK_WORKSPACE_SIDEBAR_TAB_EXTENSION_POINT,
    descriptor: WeworkWorkspaceSidebarTabDescriptor
  ): () => void
}

export interface WeworkHostService {
  readonly protocol: 'wework.host.v1'
  readonly version: string
  readonly extensions: WeworkExtensionRegistry
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

export interface DshBetterSidebarService {
  readonly version: string
  readonly features: readonly string[]
  registerTab(descriptor: WeworkWorkspaceSidebarTabDescriptor): () => void
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

const SERVICE_VERSION = '0.15.2-wework.1'
const SERVICE_FEATURES = [
  'badge',
  'tabLifecycle',
  'updateTab',
  'targetedOpen',
  'stateSubscription',
  'tabMeta',
] as const

const descriptors = new Map<string, WeworkWorkspaceSidebarTabDescriptor>()
const registryListeners = new Set<() => void>()
const stateListeners = new Set<() => void>()
const controllers = new Set<RightWorkspaceSidebarController>()
let descriptorSnapshot: readonly WeworkWorkspaceSidebarTabDescriptor[] = []

function notifyRegistry() {
  descriptorSnapshot = [...descriptors.values()]
  for (const listener of [...registryListeners]) listener()
}

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

function reportPluginError(stage: string, error: unknown) {
  console.error(`[Wework extension host] ${stage} failed:`, error)
}

export function titleOfWeworkWorkspaceSidebarTab(
  descriptor: WeworkWorkspaceSidebarTabDescriptor
): string {
  try {
    return typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
  } catch (error) {
    reportPluginError(`title "${descriptor.id}"`, error)
    return descriptor.id
  }
}

export function isWeworkWorkspaceSidebarTabAvailable(
  descriptor: WeworkWorkspaceSidebarTabDescriptor,
  scope: WeworkWorkspaceScope,
  state: WeworkWorkspaceSidebarState
): boolean {
  if (!descriptor.available) return true
  try {
    return descriptor.available(rightWorkspaceExtensionContext, scope, state)
  } catch (error) {
    reportPluginError(`available "${descriptor.id}"`, error)
    return false
  }
}

export function invokeWeworkWorkspaceSidebarLifecycle(
  descriptor: WeworkWorkspaceSidebarTabDescriptor,
  stage: 'onOpen' | 'onActivate' | 'onClose',
  tab: WeworkWorkspaceSidebarTab,
  scope: WeworkWorkspaceScope
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
      throw new Error('[Wework extension host] sidebar tab id is required')
    }
    if (descriptors.has(descriptor.id)) {
      throw new Error(
        `[Wework extension host] sidebar tab type "${descriptor.id}" already registered`
      )
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

const rightWorkspaceExtensionContextBase: WeworkExtensionContext = {
  wework: undefined as unknown as WeworkHostService,
  betterSidebar: rightWorkspaceBetterSidebar,
}

export const rightWorkspaceExtensionContext: WeworkExtensionContext = new Proxy(
  rightWorkspaceExtensionContextBase,
  {
    get(target, property, receiver) {
      if (property === 'wework') return window.__WEWORK_DSH_HOST__
      if (property === 'betterSidebar') return rightWorkspaceBetterSidebar
      const dshContext =
        typeof window === 'undefined'
          ? undefined
          : (window.__WEWORK_DSH_EXTENSIONS_BRIDGE__?.context ??
            window.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__?.context)
      if (dshContext && property in dshContext) {
        return Reflect.get(dshContext, property, dshContext)
      }
      return Reflect.get(target, property, receiver)
    },
  }
)

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
  return state ? descriptors.get(state.tab.type) : undefined
}

declare global {
  interface Window {
    __WEWORK_DSH_HOST__?: WeworkHostService
    __WEWORK_DSH_EXTENSIONS__?: WeworkExtensionRegistry
    __WEWORK_DSH_EXTENSIONS_BRIDGE__?: {
      context: WeworkExtensionContext
      service: DshBetterSidebarService
      wework: WeworkHostService
      attachHost(extensionHost: WeworkExtensionRegistry, sidebarHost: DshBetterSidebarService): void
    }
    __WEWORK_DSH_BETTER_SIDEBAR__?: DshBetterSidebarService
    __WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__?: {
      context: WeworkExtensionContext
      service: DshBetterSidebarService
      wework: WeworkHostService
      attachHost(extensionHost: WeworkExtensionRegistry, sidebarHost: DshBetterSidebarService): void
    }
  }
}

if (typeof window !== 'undefined') {
  const extensions: WeworkExtensionRegistry = {
    protocol: 'wework.extensions.v1',
    version: '1.0.0',
    extensionPoints: [WEWORK_WORKSPACE_SIDEBAR_TAB_EXTENSION_POINT],
    register(extensionPoint, descriptor) {
      if (extensionPoint !== WEWORK_WORKSPACE_SIDEBAR_TAB_EXTENSION_POINT) {
        throw new Error(`[Wework extensions] unsupported extension point "${extensionPoint}"`)
      }
      return rightWorkspaceBetterSidebar.registerTab(descriptor)
    },
  }
  const wework: WeworkHostService = {
    protocol: 'wework.host.v1',
    version: '1.0.0',
    extensions,
  }
  rightWorkspaceExtensionContextBase.wework = wework
  window.__WEWORK_DSH_HOST__ = wework
  window.__WEWORK_DSH_EXTENSIONS__ = extensions
  window.__WEWORK_DSH_BETTER_SIDEBAR__ = rightWorkspaceBetterSidebar
  window.__WEWORK_DSH_EXTENSIONS_BRIDGE__?.attachHost(extensions, rightWorkspaceBetterSidebar)
  window.__WEWORK_DSH_BETTER_SIDEBAR_BRIDGE__?.attachHost(extensions, rightWorkspaceBetterSidebar)
}
