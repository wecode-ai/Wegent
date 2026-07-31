import { Bot, CheckSquare2, Columns3, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
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

function tabKindIcon(kind: WorkspaceTabKind) {
  if (kind === 'board') {
    return <Columns3 aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  if (kind === 'agent') {
    return <Bot aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  return <CheckSquare2 aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
}

function menuPosition(trigger: HTMLElement, width: number): MenuPosition {
  const rect = trigger.getBoundingClientRect()
  return {
    left: Math.min(rect.left, window.innerWidth - width - 8),
    top: rect.bottom + 4,
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
  onContextMenu,
}: {
  tab: WorkspaceTab
  active: boolean
  onContextMenu: (position: MenuPosition, tabId: string) => void
}) {
  const { selectTab, closeTab, moveTab } = useWorkspaceTabs()
  const [dragging, setDragging] = useState(false)

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    setDragging(true)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tab.id)
  }
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain')
    if (sourceId && sourceId !== tab.id) moveTab(sourceId, tab.id)
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid={`workspace-tab-${tab.id}`}
      data-tab-kind={tab.kind}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setDragging(false)}
      onDragOver={handleDragOver}
      onAuxClick={event => {
        if (event.button === 1) closeTab(tab.id)
      }}
      onContextMenu={event => {
        event.preventDefault()
        onContextMenu({ left: event.clientX, top: event.clientY }, tab.id)
      }}
      className={cn(
        'group relative flex h-9 w-44 min-w-28 max-w-[220px] flex-none items-center overflow-visible text-sm transition-[background-color,color,opacity] duration-150',
        active
          ? 'workspace-document-tab-active z-10 rounded-t-[10px] bg-surface text-text-primary'
          : 'rounded-lg text-text-secondary hover:bg-black/[0.05] hover:text-text-primary',
        dragging && 'opacity-55'
      )}
    >
      <button
        type="button"
        data-testid={`workspace-tab-select-${tab.id}`}
        onClick={() => selectTab(tab.id)}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onContextMenu({ left: rect.left + 12, top: rect.bottom + 4 }, tab.id)
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        title={tab.title}
      >
        {tabKindIcon(tab.kind)}
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
          'mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-blue-500',
          active ? 'text-text-secondary' : 'text-text-muted group-hover:text-text-secondary'
        )}
        aria-label={`关闭 ${tab.title}`}
        title={`关闭 ${tab.title}`}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function WorkspaceTabStrip() {
  const { t } = useTranslation('common')
  const { tabs, activeTabId, openTab, selectTab, closeTab, closeOtherTabs, restoreClosedTab } =
    useWorkspaceTabs()
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [addMenuPosition, setAddMenuPosition] = useState<MenuPosition | null>(null)
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
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
        role="tablist"
        data-testid="workspace-tab-strip"
        aria-label={t('workbench.workspace_tabs', '工作区标签页')}
        className="flex h-full min-w-0 max-w-[760px] flex-1 items-end gap-0.5 overflow-hidden"
      >
        {tabs.map(tab => (
          <WorkspaceTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onContextMenu={(position, tabId) => {
              setAddMenuPosition(null)
              setContextMenu({ tabId, ...position })
            }}
          />
        ))}
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
          className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-black/[0.04] hover:text-text-primary focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label={t('workbench.workspace_tab_new', '新建标签页')}
          title={t('workbench.workspace_tab_new', '新建标签页')}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </button>
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
                  onClick={() => openNewTab(kind)}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-black/[0.04]"
                >
                  <Icon aria-hidden="true" className="h-4 w-4 text-text-secondary" />
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
                  void openWorkspaceTabWindow(contextTab).catch(error => {
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
    </>
  )
}
