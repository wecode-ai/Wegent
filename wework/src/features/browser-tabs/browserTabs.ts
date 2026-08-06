export const MAX_BROWSER_LIVE_WEBVIEWS = 10

export type BrowserTabStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface BrowserTab {
  id: string
  label: string
  baseLabel: string
  nativeLabel: string | null
  url: string | null
  title: string | null
  faviconUrl: string | null
  status: BrowserTabStatus
  suspended: boolean
  lastActiveAt: number
  agentControlled: boolean
  hasActiveDownload: boolean
  needsUserAttention: boolean
}

export interface BrowserTabCollection {
  tabs: BrowserTab[]
  activeTabId: string
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createBrowserTab(
  baseLabel: string,
  options: { id?: string; label?: string; now?: number; url?: string | null } = {}
): BrowserTab {
  const id = options.id ?? createTabId()
  return {
    id,
    label: options.label ?? baseLabel,
    baseLabel,
    nativeLabel: null,
    url: options.url ?? null,
    title: null,
    faviconUrl: null,
    status: options.url ? 'loading' : 'idle',
    suspended: false,
    lastActiveAt: options.now ?? Date.now(),
    agentControlled: false,
    hasActiveDownload: false,
    needsUserAttention: false,
  }
}

export function selectBrowserTab(
  collection: BrowserTabCollection,
  tabId: string,
  now = Date.now()
): BrowserTabCollection {
  if (!collection.tabs.some(tab => tab.id === tabId)) return collection
  return {
    tabs: collection.tabs.map(tab => (tab.id === tabId ? { ...tab, lastActiveAt: now } : tab)),
    activeTabId: tabId,
  }
}

export function moveBrowserTab(
  tabs: BrowserTab[],
  tabId: string,
  targetIndex: number
): BrowserTab[] {
  const currentIndex = tabs.findIndex(tab => tab.id === tabId)
  if (currentIndex < 0 || tabs.length < 2) return tabs
  const nextIndex = Math.max(0, Math.min(targetIndex, tabs.length - 1))
  if (currentIndex === nextIndex) return tabs
  const next = [...tabs]
  const [tab] = next.splice(currentIndex, 1)
  next.splice(nextIndex, 0, tab)
  return next
}

export function closeBrowserTab(
  collection: BrowserTabCollection,
  tabId: string
): BrowserTabCollection {
  if (collection.tabs.length <= 1) return collection
  const index = collection.tabs.findIndex(tab => tab.id === tabId)
  if (index < 0) return collection

  const tabs = collection.tabs.filter(tab => tab.id !== tabId)
  if (collection.activeTabId !== tabId) return { ...collection, tabs }

  const nextActive = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, activeTabId: nextActive.id }
}

export function findBrowserTabForLru(
  tabs: BrowserTab[],
  maxLiveWebviews = MAX_BROWSER_LIVE_WEBVIEWS,
  excludeTabId?: string
): BrowserTab | null {
  const liveTabs = tabs.filter(tab => !tab.suspended && tab.nativeLabel && tab.id !== excludeTabId)
  if (liveTabs.length < maxLiveWebviews) return null

  return (
    liveTabs
      .filter(tab => !tab.agentControlled && !tab.hasActiveDownload && !tab.needsUserAttention)
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt)[0] ?? null
  )
}

export function suspendBrowserTab(tab: BrowserTab): BrowserTab {
  return {
    ...tab,
    nativeLabel: null,
    suspended: true,
    status: 'idle',
  }
}
