import { Monitor, SquareTerminal, X } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspacePanelCards } from './WorkspacePanelCards'
import type { WorkspacePanelMenuActions } from './workspace-panel-tools'

interface BottomWorkspacePanelTab {
  id: string
  title: string
}

interface BottomWorkspacePanelProps {
  open: boolean
  active?: boolean
  preserveContent?: boolean
  testIdsEnabled?: boolean
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal?: boolean
  terminalContextTitle?: string | null
  workspaceSessionApi?: WorkspaceSessionApi
  showWorkbenchBackground?: boolean
  onRequestClose: () => void
  onTerminalTabsEmpty?: () => void
}

function createTerminalTab(index: number): BottomWorkspacePanelTab {
  return { id: `terminal-${index}`, title: `Terminal ${index}` }
}

export const BottomWorkspacePanel = memo(function BottomWorkspacePanel({
  open,
  active = true,
  preserveContent = false,
  testIdsEnabled = true,
  currentProject,
  devices,
  workspaceTarget,
  preferLocalTerminal = false,
  terminalContextTitle,
  workspaceSessionApi,
  showWorkbenchBackground = false,
  onRequestClose,
  onTerminalTabsEmpty,
}: BottomWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const { height, resizing, panelRef, handleResizeStart } = useResizableBottomPanel()
  const [terminalSequence, setTerminalSequence] = useState(2)
  const [tabs, setTabs] = useState<BottomWorkspacePanelTab[]>(() => [createTerminalTab(1)])
  const [activeTabId, setActiveTabId] = useState('terminal-1')
  const [menuActionsByTab, setMenuActionsByTab] = useState<
    Record<string, WorkspacePanelMenuActions>
  >({})
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0] ?? null
  const activeMenuActions = activeTab ? menuActionsByTab[activeTab.id] : undefined
  const renderContent = open || preserveContent
  const panelActive = active && open
  const contentTestIdsEnabled = testIdsEnabled && open
  const testId = (value: string) => (testIdsEnabled ? value : undefined)

  const openTerminalTab = useCallback(() => {
    const tab = createTerminalTab(terminalSequence)
    setTerminalSequence(current => current + 1)
    setTabs(current => [...current, tab])
    setActiveTabId(tab.id)
  }, [terminalSequence])

  const closeTab = useCallback(
    (tabId: string) => {
      const closeIndex = tabs.findIndex(tab => tab.id === tabId)
      const nextTabs = tabs.filter(tab => tab.id !== tabId)

      setMenuActionsByTab(current => {
        if (!current[tabId]) return current
        const next = { ...current }
        delete next[tabId]
        return next
      })

      if (nextTabs.length === 0) {
        const replacementTab = createTerminalTab(terminalSequence)
        setTerminalSequence(current => current + 1)
        setTabs([replacementTab])
        setActiveTabId(replacementTab.id)
        onTerminalTabsEmpty?.()
        onRequestClose()
        return
      }

      setTabs(nextTabs)

      if (activeTabId === tabId || !nextTabs.some(tab => tab.id === activeTabId)) {
        const nextTab = nextTabs[Math.max(closeIndex - 1, 0)] ?? nextTabs[0]
        setActiveTabId(nextTab.id)
      }
    },
    [activeTabId, onRequestClose, onTerminalTabsEmpty, tabs, terminalSequence]
  )

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) return

    setTabs(current => {
      const tab = current.find(item => item.id === tabId)
      if (!tab || tab.title === normalizedTitle) return current

      return current.map(item => (item.id === tabId ? { ...item, title: normalizedTitle } : item))
    })
  }, [])

  const handleMenuActionsChange = useCallback(
    (tabId: string, actions: WorkspacePanelMenuActions | null) => {
      setMenuActionsByTab(current => {
        if (!actions) {
          if (!current[tabId]) return current
          const next = { ...current }
          delete next[tabId]
          return next
        }
        if (current[tabId] === actions) return current
        return { ...current, [tabId]: actions }
      })
    },
    []
  )

  const menuItems = useMemo<WorkspaceAddMenuItem[]>(() => {
    if (!activeMenuActions) return []

    const items: WorkspaceAddMenuItem[] = []
    if (activeMenuActions.terminal.visible) {
      items.push({
        id: 'terminal',
        testId: 'workspace-add-terminal-option',
        icon: SquareTerminal,
        label: t('workbench.terminal', '终端'),
        disabled: activeMenuActions.terminal.disabled,
        onSelect: openTerminalTab,
      })
    }
    if (activeMenuActions.desktop.visible) {
      items.push({
        id: 'desktop',
        testId: 'workspace-add-desktop-option',
        icon: Monitor,
        label: t('workbench.desktop', '桌面'),
        disabled: activeMenuActions.desktop.disabled,
        onSelect: activeMenuActions.desktop.run,
      })
    }
    return items
  }, [activeMenuActions, openTerminalTab, t])

  return (
    <section
      ref={panelRef}
      data-testid={testId('bottom-workspace-panel')}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden ease-out',
        showWorkbenchBackground ? 'bg-background/20' : 'bg-background',
        resizing ? 'transition-none' : 'transition-[height,opacity,transform] duration-300',
        open
          ? 'pointer-events-auto translate-y-0 border-t border-border opacity-100'
          : 'pointer-events-none translate-y-3 border-t border-transparent opacity-0'
      )}
      style={{ height: open ? height : 0 }}
      aria-hidden={!open}
    >
      {renderContent && (
        <>
          <div
            data-testid={contentTestIdsEnabled ? 'bottom-workspace-resize-handle' : undefined}
            className="absolute left-0 top-[-4px] z-20 h-3 w-full cursor-row-resize bg-transparent"
            onPointerDown={handleResizeStart}
            aria-label={t('workbench.resize_bottom_workspace_panel')}
          />
          <button
            type="button"
            data-testid={contentTestIdsEnabled ? 'close-bottom-workspace-panel-button' : undefined}
            onClick={onRequestClose}
            className="absolute right-2 top-1 z-30 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.close_bottom_workspace_panel')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <header
            data-testid={contentTestIdsEnabled ? 'bottom-workspace-tabbar' : undefined}
            role="tablist"
            className={cn(
              'flex h-10 shrink-0 items-center gap-1.5 overflow-hidden px-2 pr-12',
              showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
            )}
          >
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              {tabs.map(tab => (
                <BottomWorkspaceTitleTab
                  key={tab.id}
                  testIdsEnabled={contentTestIdsEnabled}
                  active={activeTab?.id === tab.id}
                  label={tab.title}
                  onSelect={() => setActiveTabId(tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              ))}
            </div>
            <WorkspaceAddMenu
              ariaLabel={t('workbench.workspace_tab_new', '打开新标签页')}
              buttonTestId={contentTestIdsEnabled ? 'workspace-terminal-new-tab-button' : undefined}
              menuTestId={contentTestIdsEnabled ? 'workspace-terminal-new-tab-menu' : undefined}
              items={menuItems}
              buttonClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            />
          </header>
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {tabs.map(tab => (
              <BottomWorkspaceTabContent
                key={tab.id}
                tab={tab}
                active={activeTab?.id === tab.id}
                showWorkbenchBackground={showWorkbenchBackground}
                currentProject={currentProject}
                devices={devices}
                workspaceTarget={workspaceTarget}
                preferLocalTerminal={preferLocalTerminal}
                terminalContextTitle={terminalContextTitle}
                workspaceSessionApi={workspaceSessionApi}
                panelActive={panelActive}
                testIdsEnabled={contentTestIdsEnabled}
                onCloseTab={closeTab}
                onUpdateTabTitle={updateTabTitle}
                onMenuActionsChange={handleMenuActionsChange}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
})

function BottomWorkspaceTabContent({
  tab,
  active,
  showWorkbenchBackground,
  currentProject,
  devices,
  workspaceTarget,
  preferLocalTerminal,
  terminalContextTitle,
  workspaceSessionApi,
  panelActive,
  testIdsEnabled,
  onCloseTab,
  onUpdateTabTitle,
  onMenuActionsChange,
}: {
  tab: BottomWorkspacePanelTab
  active: boolean
  showWorkbenchBackground: boolean
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal: boolean
  terminalContextTitle?: string | null
  workspaceSessionApi?: WorkspaceSessionApi
  panelActive: boolean
  testIdsEnabled: boolean
  onCloseTab: (tabId: string) => void
  onUpdateTabTitle: (tabId: string, title: string) => void
  onMenuActionsChange: (tabId: string, actions: WorkspacePanelMenuActions | null) => void
}) {
  const handleRequestClose = useCallback(() => onCloseTab(tab.id), [onCloseTab, tab.id])
  const handleTitleChange = useCallback(
    (title: string) => onUpdateTabTitle(tab.id, title),
    [onUpdateTabTitle, tab.id]
  )
  const handleMenuActionsChange = useCallback(
    (actions: WorkspacePanelMenuActions | null) => onMenuActionsChange(tab.id, actions),
    [onMenuActionsChange, tab.id]
  )

  return (
    <div hidden={!active} className="absolute inset-0 min-h-0 w-full">
      <WorkspacePanelCards
        showWorkbenchBackground={showWorkbenchBackground}
        currentProject={currentProject}
        devices={devices}
        workspaceTarget={workspaceTarget}
        defaultOpenTool="terminal"
        onRequestClose={handleRequestClose}
        hideTerminalChrome
        preferLocalTerminal={preferLocalTerminal}
        terminalContextTitle={terminalContextTitle}
        workspaceSessionApi={workspaceSessionApi}
        panelActive={panelActive && active}
        testIdsEnabled={testIdsEnabled}
        onTerminalTitleChange={handleTitleChange}
        onMenuActionsChange={handleMenuActionsChange}
      />
    </div>
  )
}

function BottomWorkspaceTitleTab({
  testIdsEnabled,
  active,
  label,
  onSelect,
  onClose,
}: {
  testIdsEnabled: boolean
  active: boolean
  label: string
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const testId = (value: string) => (testIdsEnabled ? value : undefined)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onSelect()
  }
  return (
    <div
      data-testid={testId('bottom-workspace-terminal-tab')}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={label}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        'group relative flex h-8 min-w-0 max-w-[200px] cursor-pointer items-center gap-1.5 overflow-hidden rounded-xl py-1 pl-2 pr-7 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        active
          ? 'bg-muted text-text-primary'
          : 'bg-background text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <SquareTerminal
        data-testid={testId('bottom-workspace-terminal-tab-icon')}
        className="h-3.5 w-3.5 shrink-0 text-text-secondary"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        data-testid={testId('close-bottom-workspace-tab-button')}
        onClick={event => {
          event.stopPropagation()
          onClose()
        }}
        className="pointer-events-none absolute right-1 top-1/2 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full text-text-secondary opacity-0 transition-colors hover:!bg-text-secondary hover:text-background focus-visible:pointer-events-auto focus-visible:bg-border/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pointer-events-auto group-hover:bg-border/70 group-hover:opacity-100"
        aria-label={t('workbench.close_terminal', '关闭终端')}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
