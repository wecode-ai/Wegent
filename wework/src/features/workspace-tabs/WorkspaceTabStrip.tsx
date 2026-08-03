import { Bot, CheckSquare2, CloudOff, Columns3, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { openWorkspaceTabWindow } from './workspaceWindow'
import { useWorkspaceTabs } from './workspaceTabsContextValue'
import type { WorkspaceTab, WorkspaceTabKind } from './workspaceTabs'

interface MenuPosition {
  left: number
  top: number
}

interface TabContextMenuState extends MenuPosition {
  tabId: string
}

function tabKindIcon(kind: WorkspaceTabKind, unavailable = false) {
  if (kind === 'board') {
    return <Columns3 aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  if (kind === 'agent') {
    if (unavailable) {
      return <CloudOff aria-hidden="true" className="h-4 w-4 shrink-0 opacity-60" />
    }
    return <Bot aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  return <CheckSquare2 aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
}

function menuPosition(trigger: HTMLElement, width: number): MenuPosition {
  const rect = trigger.getBoundingClientRect()
  return clampMenuPosition({ left: rect.left, top: rect.bottom + 4 }, width, 120)
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
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEndTab}
      onDragOver={handleDragOver}
      onAuxClick={event => {
        if (event.button === 1) closeTab(tab.id)
      }}
      className={cn(
        'group relative flex h-8 w-36 min-w-28 max-w-[188px] flex-none items-center rounded-md text-sm transition-[background-color,color,opacity] duration-150',
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
        {tabKindIcon(tab.kind, unavailable)}
        <span className={cn('truncate', active && 'font-medium')}>{tab.title}</span>
      </button>
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
    </div>
  )
}

export function WorkspaceTabStrip() {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
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
  const agentAvailable = Boolean(cloud.isConnected && cloud.webUrl)
  useOutsideMenu(Boolean(addMenuPosition), addMenuRef, () => setAddMenuPosition(null))
  useOutsideMenu(Boolean(contextMenu), contextMenuRef, () => setContextMenu(null))

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
        event.preventDefault()
        closeTab(activeTabId)
        return
      }
      if (event.key.toLowerCase() === 't' && event.shiftKey) {
        event.preventDefault()
        restoreClosedTab()
        return
      }
      if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
        const index = event.key === '9' ? tabs.length - 1 : Number(event.key) - 1
        const tab = tabs[index]
        if (!tab) return
        event.preventDefault()
        selectTab(tab.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, closeTab, restoreClosedTab, selectTab, tabs])

  const openNewTab = (kind: WorkspaceTabKind) => {
    openTab(kind)
    setAddMenuPosition(null)
  }
  const contextTab = tabs.find(tab => tab.id === contextMenu?.tabId) ?? null

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
          {tabs.map(tab => (
            <WorkspaceTabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
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
            setAddMenuPosition(current => (current ? null : menuPosition(trigger, 184)))
          }}
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-black/[0.04] hover:text-text-primary focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label={t('workbench.workspace_tab_new', '新建标签页')}
          title={t('workbench.workspace_tab_new', '新建标签页')}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
      </div>
      {addMenuPosition
        ? createPortal(
            <div
              ref={addMenuRef}
              role="menu"
              data-testid="workspace-tab-add-menu"
              className="fixed z-system-popover w-[184px] rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur-md"
              style={addMenuPosition}
            >
              {(
                [
                  ['task', CheckSquare2, t('workbench.workspace_tab_task', '任务')],
                  ['board', Columns3, t('workbench.workspace_tab_board', '项目空间')],
                  ['agent', Bot, t('workbench.workspace_tab_agent', '智能体')],
                ] as const
              ).map(([kind, Icon, label]) => (
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
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-black/[0.04]"
                >
                  {kind === 'agent' && !agentAvailable ? (
                    <CloudOff aria-hidden="true" className="h-4 w-4 text-text-muted" />
                  ) : (
                    <Icon aria-hidden="true" className="h-4 w-4 text-text-secondary" />
                  )}
                  {label}
                </button>
              ))}
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
