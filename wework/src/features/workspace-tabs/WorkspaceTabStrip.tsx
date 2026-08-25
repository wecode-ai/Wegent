import { Bot, Boxes, CheckSquare2, CloudOff, Columns3, Pin, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { openWorkspaceTabWindow } from './workspaceWindow'
import { useWorkspaceTabs } from './workspaceTabsContextValue'
import type { WorkspaceTab, WorkspaceTabKind } from './workspaceTabs'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { harnessAppRoute } from '@/features/harness-apps/harnessAppTabs'

interface MenuPosition {
  left: number
  top: number
}

interface TabContextMenuState extends MenuPosition {
  tabId: string
}

const DEFAULT_AVAILABLE_KINDS: WorkspaceTabKind[] = ['task', 'board', 'agent', 'auxiliary']

interface WorkspaceTabStripProps {
  availableKinds?: readonly WorkspaceTabKind[]
}

function tabKindIcon(tab: WorkspaceTab, unavailable = false) {
  const pathname = tab.contentRoute.split('?', 1)[0]
  if (pathname === '/sites' || pathname.startsWith('/app/harness-')) {
    return <Boxes aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  if (tab.kind === 'board') {
    return <Columns3 aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  if (tab.kind === 'agent') {
    if (unavailable) {
      return <CloudOff aria-hidden="true" className="h-4 w-4 shrink-0 opacity-60" />
    }
    return <Bot aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  return <CheckSquare2 aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
}

function menuPosition(trigger: HTMLElement, width: number): MenuPosition {
  const rect = trigger.getBoundingClientRect()
  return clampMenuPosition({ left: rect.left, top: rect.bottom + 4 }, width, 152)
}

function clampMenuPosition(position: MenuPosition, width: number, height: number): MenuPosition {
  return {
    left: Math.max(8, Math.min(position.left, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(position.top, window.innerHeight - height - 8)),
  }
}

function useOutsideMenu(
  open: boolean,
  menuRef: RefObject<HTMLDivElement | null>,
  close: () => void
) {
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, menuRef, open])
}

function WorkspaceTabButton({
  tab,
  active,
  draggedTabId,
  onDragStartTab,
  onDragEndTab,
  onDragOverTab,
  onContextMenu,
  agentAvailable,
  onUnavailableAgent,
}: {
  tab: WorkspaceTab
  active: boolean
  draggedTabId: string | null
  onDragStartTab: (tabId: string) => void
  onDragEndTab: () => void
  onDragOverTab: (tabId: string) => void
  onContextMenu: (position: MenuPosition, tabId: string) => void
  agentAvailable: boolean
  onUnavailableAgent: () => void
}) {
  const { t } = useTranslation('common')
  const { selectTab, closeTab } = useWorkspaceTabs()
  const closeLabel = t('workbench.workspace_tab_close', '关闭 {{title}}', { title: tab.title })
  const unavailable = tab.kind === 'agent' && !agentAvailable
  const tabTitle = unavailable
    ? t('workbench.app_wegent_requires_cloud', '连接云端后可用')
    : tab.title

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    onDragStartTab(tab.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tab.id)
  }
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (draggedTabId && draggedTabId !== tab.id) onDragOverTab(tab.id)
  }

  return (
    <div
      data-testid={`workspace-tab-${tab.id}`}
      draggable={!tab.fixed}
      onDragStart={handleDragStart}
      onDragEnd={onDragEndTab}
      onDragOver={handleDragOver}
      onAuxClick={event => {
        if (event.button === 1 && !tab.fixed) closeTab(tab.id)
      }}
      className={cn(
        'group relative flex h-8 w-36 min-w-28 max-w-[188px] flex-none items-center rounded-md text-sm transition-[background-color,color,opacity] duration-150',
        tab.contentRoute.startsWith('/app/harness-') && 'smart-app-workspace-tab-enter',
        active
          ? 'bg-white/55 text-text-primary dark:bg-white/[0.09]'
          : 'text-text-secondary hover:bg-black/[0.045] hover:text-text-primary dark:hover:bg-white/[0.06]',
        draggedTabId === tab.id && 'opacity-55'
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-testid={`workspace-tab-select-${tab.id}`}
        data-tab-kind={tab.kind}
        data-unavailable={unavailable || undefined}
        onClick={() => {
          if (unavailable) {
            onUnavailableAgent()
            return
          }
          selectTab(tab.id)
        }}
        onContextMenu={event => {
          event.preventDefault()
          onContextMenu(
            clampMenuPosition({ left: event.clientX, top: event.clientY }, 196, 80),
            tab.id
          )
        }}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onContextMenu(
            clampMenuPosition({ left: rect.left + 12, top: rect.bottom + 4 }, 196, 80),
            tab.id
          )
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        title={tabTitle}
      >
        {tabKindIcon(tab, unavailable)}
        <span className={cn('truncate', active && 'font-medium')}>{tab.title}</span>
        {tab.fixed ? (
          <Pin
            aria-label={t('workbench.workspace_tab_fixed', '固定标签页')}
            className="ml-auto h-3 w-3 shrink-0 opacity-55"
          />
        ) : null}
      </button>
      {!tab.fixed ? (
        <button
          type="button"
          data-testid={`workspace-tab-close-${tab.id}`}
          onClick={event => {
            event.stopPropagation()
            closeTab(tab.id)
          }}
          className={cn(
            'mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded outline-none transition-[background-color,color,opacity] hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-white/[0.08]',
            active
              ? 'text-text-secondary'
              : 'opacity-0 text-text-muted group-hover:opacity-100 group-hover:text-text-secondary group-focus-within:opacity-100'
          )}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X aria-hidden="true" className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  )
}

export function WorkspaceTabStrip({
  availableKinds = DEFAULT_AVAILABLE_KINDS,
}: WorkspaceTabStripProps) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const {
    tabs,
    activeTabId,
    openTab,
    selectTab,
    closeTab,
    closeOtherTabs,
    restoreClosedTab,
    moveTab,
  } = useWorkspaceTabs()
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [addMenuPosition, setAddMenuPosition] = useState<MenuPosition | null>(null)
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [cloudConnectionOpen, setCloudConnectionOpen] = useState(false)
  const [installedSmartApps, setInstalledSmartApps] = useState<HarnessAppInstallation[]>([])
  const agentAvailable = Boolean(cloud.isConnected && cloud.webUrl)
  const availableKindSet = useMemo(() => new Set(availableKinds), [availableKinds])
  const visibleTabs = useMemo(
    () => tabs.filter(tab => availableKindSet.has(tab.kind)),
    [availableKindSet, tabs]
  )
  const visibleActiveTabId =
    visibleTabs.find(tab => tab.id === activeTabId)?.id ?? visibleTabs[0]?.id ?? activeTabId
  useOutsideMenu(Boolean(addMenuPosition), addMenuRef, () => setAddMenuPosition(null))
  useOutsideMenu(Boolean(contextMenu), contextMenuRef, () => setContextMenu(null))

  useEffect(() => {
    if (!addMenuPosition || !experimentalFeaturesEnabled) return
    let cancelled = false
    void harnessAppsApi
      .list()
      .then(apps => {
        if (!cancelled) setInstalledSmartApps(apps)
      })
      .catch(error => {
        console.warn('[Wework] failed to load installed Smart apps for the tab menu', error)
      })
    return () => {
      cancelled = true
    }
  }, [addMenuPosition, experimentalFeaturesEnabled])

  useEffect(() => {
    if (tabs.length > 0 && visibleTabs.length === 0) {
      const fallbackKind =
        availableKinds.find(kind => kind !== 'auxiliary' && kind !== 'board') ?? availableKinds[0]
      if (fallbackKind) openTab(fallbackKind)
      return
    }
    if (visibleActiveTabId === activeTabId) return
    selectTab(visibleActiveTabId)
  }, [
    activeTabId,
    availableKinds,
    openTab,
    selectTab,
    tabs.length,
    visibleActiveTabId,
    visibleTabs.length,
  ])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
        event.preventDefault()
        closeTab(visibleActiveTabId)
        return
      }
      if (event.key.toLowerCase() === 't' && event.shiftKey) {
        event.preventDefault()
        restoreClosedTab()
        return
      }
      if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
        const index = event.key === '9' ? visibleTabs.length - 1 : Number(event.key) - 1
        const tab = visibleTabs[index]
        if (!tab) return
        event.preventDefault()
        selectTab(tab.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, closeTab, restoreClosedTab, selectTab, visibleActiveTabId, visibleTabs])

  const openNewTab = (kind: WorkspaceTabKind) => {
    if (!availableKindSet.has(kind)) return
    openTab(kind)
    setAddMenuPosition(null)
  }
  const openSmartApps = () => {
    openTab('auxiliary', {
      title: t('workbench.workspace_tab_sites', '应用'),
      contentRoute: '/sites?app_type=smart_app',
    })
    setAddMenuPosition(null)
  }
  const openInstalledSmartApp = (installation: HarnessAppInstallation) => {
    const route = harnessAppRoute(installation.id)
    const existing = tabs.find(tab => tab.contentRoute === route)
    if (existing) {
      selectTab(existing.id)
    } else {
      openTab('auxiliary', {
        title: installation.manifest.displayName,
        contentRoute: route,
      })
    }
    setAddMenuPosition(null)
  }
  const contextTab = visibleTabs.find(tab => tab.id === contextMenu?.tabId) ?? null
  const addMenuKinds = (
    [
      ['task', CheckSquare2, t('workbench.workspace_tab_task', '任务')],
      ['board', Columns3, t('workbench.workspace_tab_board', '工作空间视图')],
      ['agent', Bot, t('workbench.workspace_tab_agent', '智能体')],
    ] as const
  ).filter(([kind]) => availableKindSet.has(kind))

  return (
    <>
      <div
        data-testid="workspace-tab-strip-container"
        className="flex h-full min-w-0 flex-1 items-center px-2"
      >
        <div
          role="tablist"
          data-testid="workspace-tab-strip"
          aria-label={t('workbench.workspace_tabs', '工作区标签页')}
          className="workspace-tab-strip-scrollbar flex h-full min-w-0 max-w-[calc(100%-2rem)] flex-none items-center gap-0.5 overflow-x-auto overflow-y-hidden"
        >
          {visibleTabs.map((tab, index) => (
            <div
              key={tab.id}
              className={cn(
                'flex h-full items-center',
                index > 0 &&
                  !tab.fixed &&
                  visibleTabs[index - 1]?.fixed &&
                  'ml-1 border-l border-border/70 pl-1'
              )}
            >
              <WorkspaceTabButton
                tab={tab}
                active={tab.id === visibleActiveTabId}
                draggedTabId={draggedTabId}
                onDragStartTab={setDraggedTabId}
                onDragEndTab={() => setDraggedTabId(null)}
                onDragOverTab={targetId => {
                  if (draggedTabId) moveTab(draggedTabId, targetId)
                }}
                onContextMenu={(position, tabId) => {
                  setAddMenuPosition(null)
                  setContextMenu({ tabId, ...position })
                }}
                agentAvailable={agentAvailable}
                onUnavailableAgent={() => setCloudConnectionOpen(true)}
              />
            </div>
          ))}
        </div>
        <button
          ref={addButtonRef}
          type="button"
          data-testid="workspace-tab-add"
          onClick={() => {
            const trigger = addButtonRef.current
            if (!trigger) return
            setContextMenu(null)
            setAddMenuPosition(current => (current ? null : menuPosition(trigger, 220)))
          }}
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-black/[0.04] hover:text-text-primary focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label={t('workbench.workspace_tab_new', '新建标签页')}
          title={t('workbench.workspace_tab_new', '新建标签页')}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </button>
        <div className="electron-titlebar-drag-region min-w-0 flex-1 self-stretch" />
      </div>
      {addMenuPosition
        ? createPortal(
            <div
              ref={addMenuRef}
              role="menu"
              data-testid="workspace-tab-add-menu"
              className="fixed z-system-popover max-h-[70vh] w-[220px] overflow-y-auto rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur-md"
              style={addMenuPosition}
            >
              {addMenuKinds.map(([kind, Icon, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  data-testid={`workspace-tab-add-${kind}`}
                  onClick={() => {
                    if (kind === 'agent' && !agentAvailable) {
                      setAddMenuPosition(null)
                      setCloudConnectionOpen(true)
                      return
                    }
                    openNewTab(kind)
                  }}
                  className="flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-black/[0.04] md:h-8"
                >
                  {kind === 'agent' && !agentAvailable ? (
                    <CloudOff aria-hidden="true" className="h-4 w-4 text-text-muted" />
                  ) : (
                    <Icon aria-hidden="true" className="h-4 w-4 text-text-secondary" />
                  )}
                  {label}
                </button>
              ))}
              {availableKindSet.has('auxiliary') && experimentalFeaturesEnabled ? (
                <>
                  {installedSmartApps.map(installation => (
                    <button
                      key={installation.id}
                      type="button"
                      role="menuitem"
                      data-testid={`workspace-tab-add-smart-app-${installation.id}`}
                      onClick={() => openInstalledSmartApp(installation)}
                      className="flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-black/[0.04] md:h-8"
                    >
                      <Boxes aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                      <span className="truncate">{installation.manifest.displayName}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="workspace-tab-add-smart-app"
                    onClick={openSmartApps}
                    className="flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-black/[0.04] md:h-8"
                  >
                    <Boxes aria-hidden="true" className="h-4 w-4 text-text-secondary" />
                    {t('workbench.smart_apps_manage', '管理智能工作台')}
                    <ExperimentalBadge
                      testId="workspace-tab-add-smart-app-experimental-badge"
                      className="ml-auto"
                    />
                  </button>
                </>
              ) : null}
            </div>,
            document.body
          )
        : null}
      {contextMenu && contextTab
        ? createPortal(
            <div
              ref={contextMenuRef}
              role="menu"
              data-testid="workspace-tab-context-menu"
              className="fixed z-system-popover w-[196px] rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur-md"
              style={{ left: contextMenu.left, top: contextMenu.top }}
            >
              {!contextTab.fixed ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="workspace-tab-open-new-window"
                  onClick={() => {
                    setContextMenu(null)
                    void openWorkspaceTabWindow(contextTab)
                      .then(opened => {
                        if (opened) closeTab(contextTab.id)
                      })
                      .catch(error => {
                        console.error('Failed to open workspace tab in a new window', error)
                      })
                  }}
                  className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-black/[0.04]"
                >
                  {t('workbench.workspace_tab_open_new_window', '在新窗口中打开')}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                data-testid="workspace-tab-close-others"
                onClick={() => {
                  closeOtherTabs(contextTab.id)
                  setContextMenu(null)
                }}
                className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-black/[0.04]"
              >
                {t('workbench.workspace_tab_close_others', '关闭其他标签页')}
              </button>
            </div>,
            document.body
          )
        : null}
      <CloudConnectionDialog
        open={cloudConnectionOpen}
        onlineCloudDeviceCount={0}
        onClose={() => setCloudConnectionOpen(false)}
        onOpenSettings={() => {
          setCloudConnectionOpen(false)
          navigateTo('/settings/connections')
        }}
      />
    </>
  )
}
