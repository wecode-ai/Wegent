import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { DshIcon } from '@/features/dsh-runtime/DshIcon'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { TabsList, TabsRoot } from '@wegent/collaboration/controls/Tabs'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { SquareTerminal, X } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import type { WorkspacePanelMenuActions } from './workspace-panel-tools'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspacePanelCards } from './WorkspacePanelCards'
import { WorkspaceTitleTab } from './WorkspaceTitleTab'

interface BottomWorkspacePanelTab {
  id: string
  title: string
}

interface BottomWorkspaceExtensionTab extends WeworkDshSlotEntry {
  icon?: string
  label: string
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
  workspaceActions?: WorkspaceAddMenuItem[]
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
  workspaceActions = [],
  onRequestClose,
  onTerminalTabsEmpty,
}: BottomWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const { height, resizing, panelRef, handleResizeStart } = useResizableBottomPanel(
    appearance.codeFontSize
  )
  const [terminalSequence, setTerminalSequence] = useState(2)
  const [tabs, setTabs] = useState<BottomWorkspacePanelTab[]>(() => [createTerminalTab(1)])
  const [activeTabId, setActiveTabId] = useState('terminal-1')
  const [menuActionsByTab, setMenuActionsByTab] = useState<
    Record<string, WorkspacePanelMenuActions>
  >({})
  const extensionTabs = useDshSlotEntries<BottomWorkspaceExtensionTab>(
    WEWORK_DSH_SLOTS.workspaceBottomPanelTab
  )
  const resolvedActiveTabId =
    tabs.some(tab => tab.id === activeTabId) || extensionTabs.some(tab => tab.id === activeTabId)
      ? activeTabId
      : (tabs[0]?.id ?? extensionTabs[0]?.id ?? '')
  const activeTerminalTab = tabs.find(tab => tab.id === resolvedActiveTabId) ?? null
  const activeExtensionTab = extensionTabs.find(tab => tab.id === resolvedActiveTabId) ?? null
  const activeMenuActions = activeTerminalTab ? menuActionsByTab[activeTerminalTab.id] : undefined
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
    const items: WorkspaceAddMenuItem[] = [...workspaceActions]
    if (!activeMenuActions) return items

    if (activeMenuActions.terminal.visible) {
      items.push({
        id: 'terminal',
        testId: 'workspace-add-terminal-option',
        icon: SquareTerminal,
        label: t('workbench.terminal', '终端'),
        disabled: activeMenuActions.terminal.disabled,
        title: activeMenuActions.terminal.title,
        onSelect: openTerminalTab,
      })
    }
    if (activeMenuActions.extension?.visible) {
      const extension = activeMenuActions.extension
      items.push({
        id: extension.id,
        testId: extension.testId,
        icon: extension.icon,
        label: extension.label,
        telemetryPanel: extension.telemetryPanel,
        disabled: extension.disabled,
        title: extension.title,
        onSelect: extension.run,
      })
    }
    return items
  }, [activeMenuActions, openTerminalTab, t, workspaceActions])

  return (
    <section
      ref={panelRef}
      data-testid={testId('bottom-workspace-panel')}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden ease-out',
        showWorkbenchBackground ? 'bg-background/20' : 'bg-background',
        resizing ? 'transition-none' : 'transition-[height] duration-300',
        open
          ? 'pointer-events-auto border-t border-border'
          : 'pointer-events-none border-t border-transparent'
      )}
      style={{
        flexBasis: open ? height : 0,
        height: open ? height : 0,
      }}
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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={contentTestIdsEnabled ? 'close-bottom-workspace-panel-button' : undefined}
            onClick={onRequestClose}
            className="absolute right-2 top-1 z-30 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.close_bottom_workspace_panel')}
          >
            <X className="h-3.5 w-3.5" />
          </ControlButton>
          <TabsRoot
            value={activeTabId}
            onValueChange={next => {
              if (next) setActiveTabId(next)
            }}
            render={<div className="contents" />}
          >
            <TabsList
              render={<header />}
              data-testid={contentTestIdsEnabled ? 'bottom-workspace-tabbar' : undefined}
              className={cn(
                'flex h-10 shrink-0 items-center gap-1.5 overflow-hidden px-2 pr-12',
                showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
              )}
            >
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {tabs.map(tab => (
                  <BottomWorkspaceTitleTab
                    id={tab.id}
                    key={tab.id}
                    testIdsEnabled={contentTestIdsEnabled}
                    active={activeTerminalTab?.id === tab.id}
                    label={tab.title}
                    onSelect={() => setActiveTabId(tab.id)}
                    onClose={() => closeTab(tab.id)}
                  />
                ))}
                {extensionTabs.map(tab => (
                  <BottomWorkspaceExtensionTitleTab
                    key={tab.id}
                    active={activeExtensionTab?.id === tab.id}
                    icon={tab.icon}
                    id={tab.id}
                    label={tab.label}
                    testIdsEnabled={contentTestIdsEnabled}
                    onSelect={() => setActiveTabId(tab.id)}
                  />
                ))}
              </div>
              <WorkspaceAddMenu
                ariaLabel={t('workbench.workspace_tab_new', '打开新标签页')}
                buttonTestId={
                  contentTestIdsEnabled ? 'workspace-terminal-new-tab-button' : undefined
                }
                menuTestId={contentTestIdsEnabled ? 'workspace-terminal-new-tab-menu' : undefined}
                items={menuItems}
                buttonClassName="flex shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
              />
            </TabsList>
          </TabsRoot>
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {tabs.map(tab => (
              <BottomWorkspaceTabContent
                key={tab.id}
                tab={tab}
                active={activeTerminalTab?.id === tab.id}
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
            {extensionTabs.map(tab => {
              const extensionActive = activeExtensionTab?.id === tab.id
              return (
                <div
                  key={tab.id}
                  hidden={!extensionActive}
                  className="absolute inset-0 min-h-0 w-full"
                  data-testid={
                    contentTestIdsEnabled
                      ? `bottom-workspace-extension-content-${tab.id}`
                      : undefined
                  }
                >
                  <DshContributionSlotSurface
                    attachedClassName="h-full"
                    entryId={tab.id}
                    props={{
                      active: panelActive && extensionActive,
                      currentProject,
                      devices,
                      visible: extensionActive,
                      workspaceTarget,
                    }}
                    slot={WEWORK_DSH_SLOTS.workspaceBottomPanelTab}
                  />
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
})

function BottomWorkspaceExtensionTitleTab({
  testIdsEnabled,
  active,
  icon,
  id,
  label,
  onSelect,
}: {
  testIdsEnabled: boolean
  active: boolean
  icon?: string
  id: string
  label: string
  onSelect(): void
}) {
  return (
    <WorkspaceTitleTab
      value={id}
      testId={testIdsEnabled ? `bottom-workspace-extension-tab-${id}` : undefined}
      active={active}
      label={label}
      title={label}
      onSelect={onSelect}
      icon={<DshIcon name={icon} className="h-4 w-4" />}
    />
  )
}

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
  id,
  testIdsEnabled,
  active,
  label,
  onSelect,
  onClose,
}: {
  id: string
  testIdsEnabled: boolean
  active: boolean
  label: string
  onSelect(): void
  onClose(): void
}) {
  const { t } = useTranslation('common')
  return (
    <WorkspaceTitleTab
      value={id}
      testId={testIdsEnabled ? 'bottom-workspace-terminal-tab' : undefined}
      active={active}
      label={label}
      title={label}
      onSelect={onSelect}
      onClose={onClose}
      closeTestId={testIdsEnabled ? 'close-bottom-workspace-tab-button' : undefined}
      closeLabel={t('workbench.close_terminal', '关闭终端')}
      icon={
        <SquareTerminal
          data-testid={testIdsEnabled ? 'bottom-workspace-terminal-tab-icon' : undefined}
          aria-hidden="true"
          className="h-4 w-4"
        />
      }
    />
  )
}
