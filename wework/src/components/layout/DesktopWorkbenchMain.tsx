import { WORKBENCH_MAIN_HEADER_PORTAL_ID } from '@/components/topnav/TitlebarActionsPortal'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { useRuntimeTaskSummaryResolver } from '@/features/workbench/runtimeTaskLifecycle'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { truncateRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { closeLocalTerminal } from '@/lib/local-terminal'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import styles from './DesktopWorkbenchMain.module.css'
import {
  DEFAULT_ENVIRONMENT_INFO_VISIBILITY,
  type DesktopWorkbenchMainProps,
  type EnvironmentInfoVisibilityState,
  sanitizeEmbeddedBrowserLabelSegment,
} from './desktopWorkbenchMainHelpers'
import { DesktopWorkbenchPane } from './DesktopWorkbenchPane'
import { createDesktopWorkbenchWorkspaceSource } from './desktopWorkbenchWorkspaceSource'
import type {
  LocalHarnessSessionRegistrationOptions,
  LocalHarnessWorkbenchSession,
} from './localHarnessWorkbench'
import {
  getRuntimeWorkbenchPaneKeys,
  getWorkbenchPaneKey,
  resolveRuntimeWorkbenchPane,
  type WorkbenchPaneIdentity,
} from './workbenchPaneIdentity'
import { SingleWorkbenchPane } from './workbenchPanePresentation'
import { SplitWorkbenchPaneStack } from './workbenchPaneStack'
import { getActiveWorkbenchLayout } from './workbenchSplitGroups'
export function DesktopWorkbenchMain(props: DesktopWorkbenchMainProps) {
  const { state } = useWorkbenchPaneContext()
  const resolveRuntimeTaskSummary = useRuntimeTaskSummaryResolver(state.runtimeWork)
  const { services, openRuntimeTask } = useWorkbench()
  const { t } = useTranslation('common')
  const { onLocalHarnessSessionStarted, onLocalHarnessSessionClose, onLocalHarnessSessionExit } =
    props
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const hasMainBackground = Boolean(background.imagePath && background.inMain)
  const isDesktop = isDesktopRuntime()
  const splitGroups = props.splitGroups
  const splitMode = splitGroups?.splitMode ?? false
  const [environmentInfoVisibilityByPane, setEnvironmentInfoVisibilityByPane] = useState<
    Record<string, EnvironmentInfoVisibilityState>
  >({})
  const [internalHarnessSessions, setInternalHarnessSessions] = useState<
    LocalHarnessWorkbenchSession[]
  >([])
  const [internalActiveHarnessSessionId, setInternalActiveHarnessSessionId] = useState<
    string | null
  >(null)
  const localHarnessSessions = props.localHarnessSessions ?? internalHarnessSessions
  const activeLocalHarnessSessionId =
    props.activeLocalHarnessSessionId === undefined
      ? internalActiveHarnessSessionId
      : props.activeLocalHarnessSessionId
  const activeLocalHarnessSession =
    localHarnessSessions.find(session => session.sessionId === activeLocalHarnessSessionId) ?? null
  const registerLocalHarnessSession = useCallback(
    (session: LocalHarnessWorkbenchSession, options?: LocalHarnessSessionRegistrationOptions) => {
      if (onLocalHarnessSessionStarted) {
        onLocalHarnessSessionStarted(session, options)
        return
      }
      setInternalHarnessSessions(current => [
        session,
        ...current.filter(candidate => candidate.sessionId !== session.sessionId),
      ])
      if (options?.activate !== false) {
        setInternalActiveHarnessSessionId(session.sessionId)
      }
    },
    [onLocalHarnessSessionStarted]
  )
  const handleLocalHarnessSessionExit = useCallback(
    (sessionId: string) => {
      if (onLocalHarnessSessionExit) {
        onLocalHarnessSessionExit(sessionId)
        return
      }
      const proxyToken = localHarnessSessions.find(
        session => session.sessionId === sessionId
      )?.proxyToken
      if (proxyToken) void services?.localHarnessModelApi?.unregisterProxy(proxyToken)
      setInternalHarnessSessions(current =>
        current.map(session =>
          session.sessionId === sessionId ? { ...session, proxyToken: undefined } : session
        )
      )
    },
    [localHarnessSessions, onLocalHarnessSessionExit, services?.localHarnessModelApi]
  )
  const closeHarnessSession = useCallback(
    async (sessionId: string) => {
      if (onLocalHarnessSessionClose) {
        await onLocalHarnessSessionClose(sessionId)
        return
      }
      await closeLocalTerminal(sessionId)
      handleLocalHarnessSessionExit(sessionId)
      setInternalHarnessSessions(current =>
        current.filter(session => session.sessionId !== sessionId)
      )
      setInternalActiveHarnessSessionId(current => (current === sessionId ? null : current))
    },
    [onLocalHarnessSessionClose, handleLocalHarnessSessionExit]
  )

  const runtimePaneKeys = useMemo(
    () => getRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )
  const activePaneKey = getWorkbenchPaneKey(props.activePane)
  const resolvePane = useCallback(
    (paneKey: string) => {
      if (paneKey === activePaneKey) return props.activePane
      const resolvedPane = resolveRuntimeWorkbenchPane(state.runtimeWork, paneKey)
      if (resolvedPane) return resolvedPane

      const activeLayout = props.splitGroups?.activeLayout
      const canShowBlankStartupPane =
        state.runtimeWork !== null &&
        props.activePane.currentRuntimeTask === null &&
        activeLayout?.root.type === 'pane' &&
        activeLayout.root.paneKey === paneKey &&
        paneKey.startsWith('runtime:') &&
        !runtimePaneKeys.includes(paneKey)
      return canShowBlankStartupPane ? props.activePane : null
    },
    [
      activePaneKey,
      props.activePane,
      props.splitGroups?.activeLayout,
      runtimePaneKeys,
      state.runtimeWork,
    ]
  )
  const resolveBrowserOpenRequestPaneKey = useCallback(
    (request: EmbeddedBrowserOpenRequest) => {
      const requestBaseLabel = request.baseLabel || request.label || DEFAULT_EMBEDDED_BROWSER_LABEL
      if (requestBaseLabel === DEFAULT_EMBEDDED_BROWSER_LABEL) {
        return props.visible === false ? null : activePaneKey
      }
      return (
        Array.from(new Set([activePaneKey, ...runtimePaneKeys])).find(paneKey => {
          const pane = resolvePane(paneKey)
          const labelSegment = pane?.currentRuntimeTask?.taskId ?? paneKey
          return (
            pane !== null &&
            requestBaseLabel ===
              `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(labelSegment)}`
          )
        }) ?? null
      )
    },
    [activePaneKey, props.visible, resolvePane, runtimePaneKeys]
  )
  const [workspaceSource] = useState(createDesktopWorkbenchWorkspaceSource)
  const { setResourceOwnersByPane, setPendingBrowserOpenRequests } = workspaceSource
  const workspaceObservation = workspaceSource.observe({
    activePaneKey,
    runtimePaneKeysKey: JSON.stringify(runtimePaneKeys),
    resolveBrowserOpenRequestPaneKey,
  })
  const { resourceOwnersByPane, pendingBrowserOpenRequests } = useSyncExternalStore(
    workspaceObservation.subscribe,
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )

  const retainedResourceKeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...Object.keys(resourceOwnersByPane).filter(key => resourceOwnersByPane[key].length > 0),
          ...Object.keys(pendingBrowserOpenRequests),
        ])
      ),
    [pendingBrowserOpenRequests, resourceOwnersByPane]
  )
  const setPaneResourceRetained = useCallback(
    (paneKey: string, owner: string, retained: boolean) => {
      setResourceOwnersByPane(current => {
        const owners = current[paneKey] ?? []
        const nextOwners = retained
          ? owners.includes(owner)
            ? owners
            : [...owners, owner]
          : owners.filter(candidate => candidate !== owner)
        if (
          nextOwners.length === owners.length &&
          nextOwners.every((value, index) => value === owners[index])
        ) {
          return current
        }
        if (nextOwners.length === 0) {
          const next = { ...current }
          delete next[paneKey]
          return next
        }
        return { ...current, [paneKey]: nextOwners }
      })
    },
    [setResourceOwnersByPane]
  )
  const rememberPaneWorkspaceState = workspaceSource.rememberPaneWorkspaceState
  const transferPaneWorkspaceState = workspaceSource.transferPaneWorkspaceState
  const updateEnvironmentInfoVisibility = useCallback(
    (paneId: string, patch: Partial<EnvironmentInfoVisibilityState>) => {
      setEnvironmentInfoVisibilityByPane(current => ({
        ...current,
        [paneId]: {
          ...(current[paneId] ?? DEFAULT_ENVIRONMENT_INFO_VISIBILITY),
          ...patch,
        },
      }))
    },
    []
  )

  const markBrowserOpenRequestHandled = useCallback(
    (paneKey: string, requestId: string) => {
      setPendingBrowserOpenRequests(current => {
        if (current[paneKey]?.id !== requestId) return current
        const next = { ...current }
        delete next[paneKey]
        return next
      })
    },
    [setPendingBrowserOpenRequests]
  )
  const getPaneTitle = useCallback(
    (pane: WorkbenchPaneIdentity) => {
      if (!pane.currentRuntimeTask) {
        return pane.currentProject?.name ?? t('workbench.new_chat', '新任务')
      }
      const task = resolveRuntimeTaskSummary(pane.currentRuntimeTask)
      return (
        truncateRuntimeTaskTitle(task?.title) ??
        t('workbench.task_fallback_title', {
          defaultValue: '任务 {{taskId}}',
          taskId: pane.currentRuntimeTask.taskId,
        })
      )
    },
    [resolveRuntimeTaskSummary, t]
  )
  const focusPane = useCallback(
    (pane: WorkbenchPaneIdentity) => {
      if (pane.currentRuntimeTask) void openRuntimeTask(pane.currentRuntimeTask)
    },
    [openRuntimeTask]
  )
  const renderWorkbenchPane = useCallback(
    (pane: WorkbenchPaneIdentity) => (
      <DesktopWorkbenchPane
        workspaceSource={workspaceSource}
        pane={pane}
        workbenchVisible={props.visible ?? true}
        sidebarCollapsed={props.sidebarCollapsed}
        sidebarResizing={props.sidebarResizing ?? false}
        presentation={props.presentation ?? 'workbench'}
        workspaceSessionApi={services?.workspaceSessionApi}
        environmentInfoVisibilityByPane={environmentInfoVisibilityByPane}
        onSidebarCollapsedChange={props.onSidebarCollapsedChange}
        onEnvironmentInfoVisibilityChange={updateEnvironmentInfoVisibility}
        onPaneResourceRetained={setPaneResourceRetained}
        pendingBrowserOpenRequest={pendingBrowserOpenRequests[getWorkbenchPaneKey(pane)] ?? null}
        onBrowserOpenRequestHandled={markBrowserOpenRequestHandled}
        initialWorkspaceState={workspaceSource.readPaneWorkspaceState(getWorkbenchPaneKey(pane))}
        onWorkspaceStateChange={rememberPaneWorkspaceState}
        onRuntimeTaskCreated={transferPaneWorkspaceState}
        onLocalHarnessSessionStarted={registerLocalHarnessSession}
        localHarnessSessions={localHarnessSessions}
        activeLocalHarnessSession={
          getWorkbenchPaneKey(pane) === activePaneKey ? activeLocalHarnessSession : null
        }
        onLocalHarnessSessionClose={closeHarnessSession}
        onLocalHarnessSessionExit={handleLocalHarnessSessionExit}
      />
    ),
    [
      workspaceSource,
      props.visible,
      props.sidebarCollapsed,
      props.sidebarResizing,
      props.presentation,
      props.onSidebarCollapsedChange,
      services?.workspaceSessionApi,
      environmentInfoVisibilityByPane,
      updateEnvironmentInfoVisibility,
      setPaneResourceRetained,
      pendingBrowserOpenRequests,
      markBrowserOpenRequestHandled,
      rememberPaneWorkspaceState,
      transferPaneWorkspaceState,
      registerLocalHarnessSession,
      localHarnessSessions,
      activePaneKey,
      activeLocalHarnessSession,
      closeHarnessSession,
      handleLocalHarnessSessionExit,
    ]
  )
  const paneStack = splitGroups ? (
    <SplitWorkbenchPaneStack
      key={state.user?.id}
      devices={state.devices}
      activePane={props.activePane}
      layout={splitGroups.activeLayout}
      showWorkbenchBackground={hasMainBackground}
      validRuntimeKeys={runtimePaneKeys}
      retainedResourceKeys={retainedResourceKeys}
      activeTestId={props.visible === false ? null : 'desktop-workbench-main'}
      workbenchVisible={props.visible ?? true}
      resolvePane={resolvePane}
      getPaneTitle={getPaneTitle}
      onPaneFocus={focusPane}
      onLayoutFocus={splitGroups.focusPane}
      onLayoutClose={paneId => getActiveWorkbenchLayout(splitGroups.closePane(paneId))}
      onLayoutSplit={splitGroups.splitPane}
      onLayoutPlace={splitGroups.placeTask}
      onLayoutSizesChange={splitGroups.updateSizes}
      renderPane={renderWorkbenchPane}
    />
  ) : (
    <SingleWorkbenchPane
      pane={props.activePane}
      devices={state.devices}
      visible={props.visible ?? true}
      renderPane={renderWorkbenchPane}
    />
  )

  const mainContent = (
    <div
      data-testid="desktop-workbench-pane-stack-container"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {paneStack}
    </div>
  )

  if (!isDesktop) return mainContent

  return (
    <div
      className={cn(
        'relative flex min-w-0 flex-1 flex-col overflow-hidden',
        props.presentation !== 'popout' && styles.frame,
        background.imagePath && (background.inMain || background.inTopBar)
          ? 'bg-transparent'
          : 'bg-background'
      )}
    >
      {!splitMode && props.presentation !== 'popout' ? (
        <header
          id={WORKBENCH_MAIN_HEADER_PORTAL_ID}
          data-testid="workbench-main-header"
          className={cn(
            'relative z-chrome flex h-[38px] shrink-0 items-center overflow-hidden border-b border-border/40',
            background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95'
          )}
        />
      ) : null}
      {mainContent}
    </div>
  )
}
