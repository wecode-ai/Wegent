import { useIssueAssignmentCount } from '@/features/todo/useIssueAssignmentCount'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import {
  getAppPreferences,
  type AppPreferences,
  type FixedWorkspaceTabPreference,
} from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { COLLABORATION_EXP_PATH } from '@/features/collaboration-exp/collaborationExpFeature'
import { DshIcon } from '@/features/dsh-runtime/DshIcon'
import { resolveDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { dshWorkspaceTabRoute, dshWorkspaceTabs } from '@/features/dsh-runtime/dshWorkspaceTabs'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useAppPreferenceFeatureState } from '@/features/experimental-features/useAppPreferenceFeatureState'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { harnessAppRoute } from '@/features/harness-apps/harnessAppTabs'
import {
  INTERACTIONS_PATH,
  useRuntimeInteractions,
} from '@/features/notifications/RuntimeInteractionsContext'
import { openRuntimeInteractionsTab } from '@/features/notifications/runtimeInteractionsNavigation'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { ActionMenu } from '@wegent/collaboration/controls/ActionMenu'
import { TabsList, TabsRoot, TabsTab } from '@wegent/collaboration/controls/Tabs'
import { useDOMEvent, useElementGeometry } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Bot, Boxes, CheckSquare2, CloudOff, Columns3, Pin, Plus, X } from 'lucide-react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
} from 'react'
import {
  fixedWorkspaceTabPreference,
  fixedWorkspaceWindowLabel,
  saveFixedWorkspaceTabs,
} from './fixedWorkspaceTabs'
import type { WorkspaceTab, WorkspaceTabKind } from './workspaceTabs'
import { useWorkspaceTabs, useWorkspaceTabsSession } from './workspaceTabsContextValue'
import {
  closeEmptyWorkspaceWindow,
  openWorkspaceTabWindow,
  returnWorkspaceTabToMain,
} from './workspaceWindow'

type MenuPosition = CSSProperties & {
  left: number
  top: number
}

interface TabContextMenuState extends MenuPosition {
  tabId: string
}

const DEFAULT_AVAILABLE_KINDS: WorkspaceTabKind[] = ['task', 'board', 'agent', 'auxiliary']

interface WorkspaceTabStripProps {
  availableKinds?: readonly WorkspaceTabKind[]
  className?: string
}

function tabKindIcon(tab: WorkspaceTab, unavailable = false) {
  const pathname = tab.contentRoute.split('?', 1)[0]
  const routeIcon = resolveDshRoute(pathname)?.icon
  if (pathname.startsWith('/app/harness-')) {
    return <Boxes aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
  }
  if (routeIcon !== undefined) {
    return <DshIcon name={routeIcon} aria-hidden="true" className="h-4 w-4 shrink-0 opacity-75" />
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

function clampMenuPosition(position: MenuPosition, width: number, height: number): MenuPosition {
  return {
    left: Math.max(8, Math.min(position.left, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(position.top, window.innerHeight - height - 8)),
  }
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
  issueAssignmentCount,
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
  issueAssignmentCount: number | null
}) {
  const { t } = useTranslation('common')
  const { selectTab, closeTab } = useWorkspaceTabs()
  const interactions = useRuntimeInteractions()
  const pendingTab = tab.contentRoute.split('?', 1)[0] === INTERACTIONS_PATH
  const pendingCount =
    interactions &&
    pendingTab &&
    (!interactions.projectItemsSupported || interactions.pendingProjectCount != null)
      ? interactions.pending.length + (interactions.pendingProjectCount ?? 0)
      : null
  const label = pendingTab ? t('interactions.title', '待你处理') : tab.title
  const title =
    pendingCount !== null
      ? t('interactions.tab_title_with_count', '待你处理（{{count}}）', {
          count: pendingCount,
        })
      : issueAssignmentCount !== null
        ? t('workbench.collaboration_assignment_count', {
            title: label,
            count: issueAssignmentCount,
          })
        : label
  const closeLabel = t('workbench.workspace_tab_close', '关闭 {{title}}', { title })
  const unavailable = tab.kind === 'agent' && !agentAvailable
  const tabTitle = unavailable ? t('workbench.app_wegent_requires_cloud', '连接云端后可用') : title

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
        'group relative flex h-12 w-36 min-w-0 max-w-[min(188px,var(--workspace-tab-viewport-width,188px))] flex-none items-center rounded-md text-sm transition-[background-color,color,opacity] duration-150 md:h-8',
        pendingCount !== null && 'w-40',
        tab.contentRoute.startsWith('/app/harness-') && 'smart-app-workspace-tab-enter',
        active
          ? 'border border-border/70 bg-surface text-text-primary shadow-sm wework:bg-white wework:dark:bg-white/[0.09]'
          : 'border border-transparent text-text-secondary hover:bg-muted hover:text-text-primary wework:hover:bg-black/[0.045] wework:dark:hover:bg-white/[0.06]',
        draggedTabId === tab.id && 'opacity-55'
      )}
    >
      <TabsTab
        appearance="surface"
        value={tab.id}
        type="button"
        id={`workspace-tab-select-${tab.id}`}
        aria-controls={`workspace-tab-content-${tab.id}`}
        data-tab-id={tab.id}
        data-testid={`workspace-tab-select-${tab.id}`}
        data-pending-question-count={pendingTab ? interactions?.pending.length : undefined}
        data-project-pending-count={
          pendingTab
            ? interactions?.projectItemsSupported
              ? (interactions.pendingProjectCount ?? undefined)
              : 0
            : undefined
        }
        data-project-count-state={
          pendingTab
            ? !interactions
              ? 'loading'
              : !interactions.projectItemsSupported
                ? 'unsupported'
                : interactions.pendingProjectCount == null
                  ? 'unknown'
                  : 'known'
            : undefined
        }
        data-tab-kind={tab.kind}
        data-unavailable={unavailable || undefined}
        onContextMenu={event => {
          event.preventDefault()
          onContextMenu(
            clampMenuPosition({ left: event.clientX, top: event.clientY }, 196, 112),
            tab.id
          )
        }}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onContextMenu(
            clampMenuPosition({ left: rect.left + 12, top: rect.bottom + 4 }, 196, 112),
            tab.id
          )
        }}
        className="flex h-full min-w-11 flex-1 items-center gap-1.5 px-2.5 text-left outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus md:min-w-0 wework:keyboard:focus-visible:ring-blue-500"
        title={tabTitle}
        onClick={() => {
          if (!active) return
          if (unavailable) onUnavailableAgent()
          else selectTab(tab.id)
        }}
      >
        {tabKindIcon(tab, unavailable)}
        <span className={cn('flex min-w-0 items-center', active && 'font-medium')}>
          <span className="truncate">{label}</span>
          {pendingCount !== null ? (
            <span
              data-testid={`workspace-tab-pending-count-${tab.id}`}
              className="shrink-0 whitespace-pre tabular-nums"
            >
              {t('interactions.tab_pending_count', '（{{count}}）', { count: pendingCount })}
            </span>
          ) : null}
          {issueAssignmentCount !== null && (
            <span
              data-testid="workspace-tab-issue-assignment-count"
              className="shrink-0 whitespace-pre tabular-nums"
            >
              {t('interactions.tab_pending_count', '（{{count}}）', {
                count: issueAssignmentCount,
              })}
            </span>
          )}
        </span>
        {tab.fixed ? (
          <Pin
            aria-label={t('workbench.workspace_tab_fixed', '固定标签页')}
            className="ml-auto h-3 w-3 shrink-0 opacity-55"
          />
        ) : null}
      </TabsTab>
      {!tab.fixed ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`workspace-tab-close-${tab.id}`}
          tabIndex={active ? 0 : -1}
          onClick={event => {
            event.stopPropagation()
            closeTab(tab.id)
          }}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded outline-none transition-[background-color,color,opacity] hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:mr-1.5 md:h-6 md:w-6 wework:hover:bg-black/[0.06] wework:keyboard:focus-visible:ring-blue-500 wework:dark:hover:bg-white/[0.08]',
            active
              ? 'text-text-secondary'
              : 'text-text-secondary md:opacity-0 group-hover:opacity-100 group-hover:text-text-secondary group-focus-within:opacity-100'
          )}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X aria-hidden="true" className="h-3 w-3" />
        </ControlButton>
      ) : null}
    </div>
  )
}

export function WorkspaceTabStrip({
  availableKinds = DEFAULT_AVAILABLE_KINDS,
  className,
}: WorkspaceTabStripProps) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const issueAssignmentCount = useIssueAssignmentCount(cloud, availableKinds.includes('board'))
  const appPreferences = useAppPreferencesState()
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const collaborationExperience = useAppPreferenceFeatureState('collaborationExperienceEnabled')
  const {
    tabs,
    openTab,
    selectTab,
    closeTab,
    detachTab,
    closeOtherTabs,
    restoreClosedTab,
    moveTab,
  } = useWorkspaceTabs()
  const tabStripRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [cloudConnectionOpen, setCloudConnectionOpen] = useState(false)
  const installedAppsResource = useMemo(
    () =>
      createAsyncResource('workspace-tab-installed-apps', () => harnessAppsApi.list(), {
        refreshOnSubscribe: true,
        failure: error =>
          console.warn('[Wework] failed to load installed Smart apps for the tab menu', error),
      }),
    []
  )
  const installedApps = useSyncExternalStore(
    addMenuOpen && experimentalFeaturesEnabled
      ? installedAppsResource.subscribe
      : subscribeIdleResource,
    installedAppsResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const installedSmartApps = installedApps.data ?? []
  const registeredDshTabs = useSyncExternalStore(
    dshWorkspaceTabs.subscribe,
    dshWorkspaceTabs.getTabs,
    dshWorkspaceTabs.getTabs
  )
  const agentAvailable = Boolean(cloud.isConnected && cloud.webUrl)
  const availableKindSet = useMemo(() => new Set(availableKinds), [availableKinds])
  const session = useWorkspaceTabsSession()
  const availableTabs = useMemo(
    () => session.observeAvailableTabs(availableKinds),
    [session, availableKinds]
  )
  const { tabs: visibleTabs, activeTabId: visibleActiveTabId } = useSyncExternalStore(
    availableTabs.subscribe,
    availableTabs.getSnapshot,
    availableTabs.getSnapshot
  )
  const rovingTabId = visibleTabs.some(tab => tab.id === focusedTabId)
    ? focusedTabId
    : visibleActiveTabId

  const geometryTargets = useMemo(() => [containerRef, tabStripRef], [])
  const geometry = useElementGeometry(geometryTargets)
  const bindTabStrip = useCallback(
    (strip: HTMLDivElement | null) => {
      tabStripRef.current = strip
      if (!strip?.clientWidth) return
      strip.style.setProperty('--workspace-tab-viewport-width', `${strip.clientWidth}px`)
      const targetId = visibleTabs.find(tab => tab.id === rovingTabId)?.id ?? visibleActiveTabId
      const active = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).find(
        tab => tab.dataset.tabId === targetId
      )?.parentElement
      if (!active) return
      const viewport = geometry?.elements[1] ?? strip.getBoundingClientRect()
      const tab = active.getBoundingClientRect()
      if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left
      else if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right
    },
    [geometry, rovingTabId, visibleActiveTabId, visibleTabs]
  )

  useDOMEvent<KeyboardEvent>('window', 'keydown', event => {
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
  })

  const openNewTab = (kind: WorkspaceTabKind) => {
    if (!availableKindSet.has(kind)) return
    openTab(kind)
    setAddMenuOpen(false)
  }
  const openSmartApps = () => {
    openTab('auxiliary', {
      title: t('workbench.workspace_tab_sites', '应用'),
      contentRoute: '/sites?app_type=smart_app',
    })
    setAddMenuOpen(false)
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
    setAddMenuOpen(false)
  }
  const openDshWorkspaceTab = (id: string, title: string) => {
    const route = dshWorkspaceTabRoute(id)
    const existing = tabs.find(tab => tab.contentRoute === route)
    if (existing) selectTab(existing.id)
    else openTab('auxiliary', { title, contentRoute: route })
    setAddMenuOpen(false)
  }
  const contextTab = visibleTabs.find(tab => tab.id === contextMenu?.tabId) ?? null
  const detachedWindow = getDesktopWindowLabel().startsWith('workspace-')
  const returnContextTabToMain = async () => {
    if (!contextTab || !detachedWindow) return
    setContextMenu(null)
    try {
      await returnWorkspaceTabToMain(contextTab)
      detachTab?.(contextTab.id)
      if (tabs.length === 1) await closeEmptyWorkspaceWindow()
    } catch (error) {
      console.error('Failed to return workspace tab to main window', error)
    }
  }
  const pinContextTab = async () => {
    if (!contextTab || contextTab.fixed || !appPreferences?.loaded) return
    setContextMenu(null)
    const preference = fixedWorkspaceTabPreference(contextTab)
    const windowLabel = getDesktopWindowLabel()
    try {
      const preferences = await getAppPreferences()
      await saveFixedWorkspaceTabs(
        [
          ...preferences.fixedWorkspaceTabs.filter(tab => tab.id !== contextTab.id),
          windowLabel.startsWith('workspace-') ? { ...preference, windowLabel } : preference,
        ],
        preferences.startupWorkspaceTabId
      )
    } catch (error) {
      console.error('Failed to pin workspace tab', error)
    }
  }
  const unpinContextTab = async () => {
    if (!contextTab?.fixed || !appPreferences?.loaded) return
    setContextMenu(null)
    try {
      const preferences = await getAppPreferences()
      await saveFixedWorkspaceTabs(
        preferences.fixedWorkspaceTabs.filter(tab => tab.id !== contextTab.id),
        preferences.startupWorkspaceTabId
      )
    } catch (error) {
      console.error('Failed to unpin workspace tab', error)
    }
  }
  const openContextTabInNewWindow = async () => {
    if (!contextTab) return
    setContextMenu(null)
    let preferences: AppPreferences | null = null
    let fixedPreference: FixedWorkspaceTabPreference | undefined
    try {
      preferences = await getAppPreferences()
      fixedPreference = preferences.fixedWorkspaceTabs.find(tab => tab.id === contextTab.id)
      const label = fixedPreference ? fixedWorkspaceWindowLabel(contextTab.id) : undefined
      if (fixedPreference) {
        await saveFixedWorkspaceTabs(
          preferences.fixedWorkspaceTabs.map(tab =>
            tab.id === contextTab.id
              ? { ...fixedWorkspaceTabPreference(contextTab), windowLabel: label }
              : tab
          ),
          preferences.startupWorkspaceTabId
        )
      }
      const opened = label
        ? await openWorkspaceTabWindow(contextTab, { label })
        : await openWorkspaceTabWindow(contextTab)
      if (opened) {
        if (detachTab) detachTab(contextTab.id)
        else closeTab(contextTab.id)
      }
    } catch (error) {
      if (fixedPreference && preferences) {
        void saveFixedWorkspaceTabs(
          preferences.fixedWorkspaceTabs,
          preferences.startupWorkspaceTabId
        ).catch(rollbackError => {
          console.error('Failed to restore pinned workspace tab after window error', rollbackError)
        })
      }
      console.error('Failed to open workspace tab in a new window', error)
    }
  }
  const addMenuKinds = (
    [
      ['task', CheckSquare2, t('workbench.workspace_tab_task', '任务')],
      ['board', Columns3, t('workbench.workspace_tab_board', '协作')],
      ['agent', Bot, t('workbench.workspace_tab_agent', '智能体')],
    ] as const
  ).filter(([kind]) => availableKindSet.has(kind))

  return (
    <>
      <div
        ref={containerRef}
        data-testid="workspace-tab-strip-container"
        className={cn('flex h-full min-w-0 flex-1 items-center px-2', className)}
      >
        <TabsRoot
          value={visibleActiveTabId}
          activation="manual"
          onValueChange={(next, details) => {
            if (!next) return
            const tab = visibleTabs.find(tab => tab.id === next)
            if (tab?.kind === 'agent' && !agentAvailable) {
              details.cancel()
              setCloudConnectionOpen(true)
              return
            }
            selectTab(next)
          }}
          render={<div className="contents" />}
        >
          <TabsList
            appearance="surface"
            render={<div />}
            ref={bindTabStrip}
            data-testid="workspace-tab-strip"
            aria-label={t('workbench.workspace_tabs', '工作区标签页')}
            className="workspace-tab-strip-scrollbar flex h-full min-w-0 max-w-[calc(100%-3rem)] flex-none items-center gap-0.5 overflow-x-auto overflow-y-hidden md:max-w-[calc(100%-2rem)]"
            onFocusCapture={event => {
              if (
                event.target instanceof HTMLElement &&
                event.target.getAttribute('role') === 'tab'
              ) {
                setFocusedTabId(event.target.dataset.tabId ?? null)
              }
            }}
            onBlurCapture={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTabId(null)
            }}
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
                  issueAssignmentCount={
                    tab.kind === 'board' && tab.fixed ? issueAssignmentCount : null
                  }
                  active={tab.id === visibleActiveTabId}
                  draggedTabId={draggedTabId}
                  onDragStartTab={setDraggedTabId}
                  onDragEndTab={() => setDraggedTabId(null)}
                  onDragOverTab={targetId => {
                    if (draggedTabId) moveTab(draggedTabId, targetId)
                  }}
                  onContextMenu={(position, tabId) => {
                    setAddMenuOpen(false)
                    setContextMenu({ tabId, ...position })
                  }}
                  agentAvailable={agentAvailable}
                  onUnavailableAgent={() => setCloudConnectionOpen(true)}
                />
              </div>
            ))}
          </TabsList>
        </TabsRoot>
        <ActionMenu
          testId="workspace-tab-add"
          icon={Plus}
          density="dense"
          triggerClassName="ml-1 shrink-0 transition-colors hover:text-text-primary wework:hover:bg-black/[0.04] wework:keyboard:focus-visible:ring-blue-500"
          open={addMenuOpen}
          onOpenChange={next => {
            if (next) setContextMenu(null)
            setAddMenuOpen(next)
          }}
          ariaLabel={t('workbench.workspace_tab_new', '新建标签页')}
          menuTestId="workspace-tab-add-menu"
          placement="bottom-start"
          width={220}
          items={[
            ...addMenuKinds.map(([kind, Icon, label]) => ({
              testId: `workspace-tab-add-${kind}`,
              label,
              icon: kind === 'agent' && !agentAvailable ? CloudOff : Icon,
              onSelect: () => {
                if (kind === 'agent' && !agentAvailable) {
                  setAddMenuOpen(false)
                  setCloudConnectionOpen(true)
                  return
                }
                openNewTab(kind)
              },
            })),
            ...(availableKindSet.has('auxiliary')
              ? [
                  {
                    testId: 'workspace-tab-add-pending-interactions',
                    label: t('interactions.title', '待你处理'),
                    icon: CheckSquare2,
                    onSelect: () => {
                      openRuntimeInteractionsTab(
                        { tabs, selectTab, openTab },
                        t('interactions.title', '待你处理')
                      )
                      setAddMenuOpen(false)
                    },
                  },
                ]
              : []),
            ...(availableKindSet.has('auxiliary') && collaborationExperience.enabled
              ? [
                  {
                    testId: 'workspace-tab-add-collaboration-exp',
                    label: t('workbench.workspace_tab_collaboration_exp', '协作 exp'),
                    icon: Columns3,
                    onSelect: () => {
                      openTab('auxiliary', {
                        contentRoute: COLLABORATION_EXP_PATH,
                        title: t('workbench.workspace_tab_collaboration_exp', '协作 exp'),
                      })
                      setAddMenuOpen(false)
                    },
                  },
                ]
              : []),
            ...(availableKindSet.has('auxiliary') && experimentalFeaturesEnabled
              ? [
                  ...installedSmartApps.map(installation => ({
                    testId: `workspace-tab-add-smart-app-${installation.id}`,
                    label: installation.manifest.displayName,
                    icon: Boxes,
                    onSelect: () => openInstalledSmartApp(installation),
                  })),
                  {
                    testId: 'workspace-tab-add-smart-app',
                    label: (
                      <>
                        {t('workbench.smart_apps_manage', '管理智能工作台')}
                        <ExperimentalBadge
                          testId="workspace-tab-add-smart-app-experimental-badge"
                          className="ml-auto"
                        />
                      </>
                    ),
                    icon: Boxes,
                    onSelect: openSmartApps,
                  },
                ]
              : []),
            ...(availableKindSet.has('auxiliary')
              ? [...registeredDshTabs]
                  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
                  .map(descriptor => ({
                    testId: `workspace-tab-add-dsh-${descriptor.id}`,
                    label: descriptor.title,
                    icon: Boxes,
                    onSelect: () => openDshWorkspaceTab(descriptor.id, descriptor.title),
                  }))
              : []),
          ]}
        />
        <div className="electron-titlebar-drag-region min-w-0 flex-1 self-stretch" />
      </div>
      {
        <ActionMenu
          hideTrigger
          contextMenuPosition={contextMenu && contextTab ? contextMenu : null}
          onContextMenuClose={() => setContextMenu(null)}
          ariaLabel={contextTab?.title ?? t('workbench.workspace_tabs', '工作区标签页')}
          menuTestId="workspace-tab-context-menu"
          width={196}
          items={
            contextTab
              ? [
                  {
                    testId: contextTab.fixed ? 'workspace-tab-unpin' : 'workspace-tab-pin',
                    label: t(
                      contextTab.fixed
                        ? 'workbench.workspace_tab_unpin'
                        : 'workbench.workspace_tab_pin'
                    ),
                    icon: Pin,
                    disabled: !appPreferences?.loaded,
                    onSelect: () => {
                      if (contextTab.fixed) void unpinContextTab()
                      else void pinContextTab()
                    },
                  },
                  {
                    testId: 'workspace-tab-open-new-window',
                    label: t('workbench.workspace_tab_open_new_window', '在新窗口中打开'),
                    onSelect: () => void openContextTabInNewWindow(),
                  },
                  ...(detachedWindow
                    ? [
                        {
                          testId: 'workspace-tab-return-to-main',
                          label: t('workbench.workspace_tab_return_to_main', '移回主窗口'),
                          onSelect: () => void returnContextTabToMain(),
                        },
                      ]
                    : []),
                  {
                    testId: 'workspace-tab-close-others',
                    label: t('workbench.workspace_tab_close_others', '关闭其他标签页'),
                    onSelect: () => {
                      closeOtherTabs(contextTab.id)
                      setContextMenu(null)
                    },
                  },
                ]
              : []
          }
        />
      }
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
