import type { RightWorkspaceTerminalTab } from './workspace-panels/RightWorkspacePanel'
import {
  createDesktopPaneSidebarService,
  type DesktopPaneSidebarInput,
} from './desktopPaneSidebarService'
import type { RuntimeInteractionsValue } from '@/features/notifications/RuntimeInteractionsContext'
import {
  subscribeWorkbenchWorkspaceLaunch,
  consumeWorkbenchWorkspaceLaunch,
} from '@/features/workbench/workspaceLaunchRequest'
import { rightWorkspaceDshSidebar } from './workspace-panels/rightWorkspaceDshSidebar'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import type { DesktopReviewMetadata } from './desktopWorkbenchPaneTypes'
import type { createWorkspaceTabsSession } from '@/features/workspace-tabs/workspaceTabsSession'
import type { createDesktopWorkbenchWorkspaceSource } from './desktopWorkbenchWorkspaceSource'
import {
  createDesktopPaneBrowserService,
  type DesktopPaneBrowserInput,
} from './desktopPaneBrowserService'
import type { FeedbackDialogRequest } from '@/features/feedback/feedbackDialogStore'
import type { WorkbenchMessage } from '@/types/workbench'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import { DEFAULT_EMBEDDED_BROWSER_LABEL, setEmbeddedBrowserActiveTab } from '@/lib/embedded-browser'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import {
  projectDesktopPanePanels,
  type DesktopPanePanelProjectionInput,
} from './desktopPanePanelProjection'
import { createDesktopPaneSubagents, type DesktopPaneSubagentInput } from './desktopPaneSubagents'
import type {
  DesktopPaneWorkspaceState,
  DesktopPaneWorkspaceSnapshot,
} from './desktopPaneWorkspaceState'
import type { BottomPanelRenderContext } from './desktopWorkbenchPaneTypes'
import {
  isRightWorkspaceBrowserTab,
  isRightWorkspaceTerminalTab,
  getRightWorkspaceTerminalNumericSuffix,
  isRightWorkspaceHarnessTab,
  type WorkbenchPaneWorkspaceState,
} from './desktopWorkbenchMainHelpers'
import { isQuestionDiscussionTab } from '@/features/notifications/questionDiscussion'
import type {
  RightWorkspaceBrowserTab,
  RightWorkspaceChatTab,
} from './workspace-panels/RightWorkspacePanel'

export interface DesktopPaneWorkspaceInput
  extends DesktopPaneSubagentInput, DesktopPanePanelProjectionInput {
  setHasPreviousTurnReview(value: boolean): void
  sidebar: DesktopPaneSidebarInput
  registerInteractionView: RuntimeInteractionsValue['registerView'] | undefined
  interactionViewOwner: string
  viewedInteractionId: string | null
  workspaceLaunchDeviceId: string | undefined
  workspaceLaunchPath: string | undefined
  replacePaneInput(text: string): void
  openWorkspaceFileFromMessage(path: string, options?: WorkspaceFileOpenOptions): Promise<void>
  openReviewFromDiffLoader(
    loadDiff: () => Promise<string>,
    metadata?: DesktopReviewMetadata
  ): Promise<void>
  browser: DesktopPaneBrowserInput
  tabs: ReturnType<typeof createWorkspaceTabsSession> | null
  workspaceSource: ReturnType<typeof createDesktopWorkbenchWorkspaceSource>
  workspaceTabId?: string
  ownershipKey: string
  paneKey: string
  paneActive: boolean
  paneVisible: boolean
  workbenchVisible: boolean
  services: WorkbenchServices
  sourceBrowserLabel: string
  rightPanelSessionKey: string
  startupSurfaceReady: boolean
  startupSurfaceSource: string
  paneMessages: WorkbenchMessage[]
  feedbackDialogRequest: FeedbackDialogRequest
  activeBottomPanelContext: BottomPanelRenderContext
  environmentInfoDocked: boolean
  environmentInfoLayoutRightPanelOpen: boolean
  setEnvironmentInfoOpen(open: boolean): void
  onEnvironmentOverlayDismiss(): void
  onWorkspaceStateChange(paneKey: string, state: WorkbenchPaneWorkspaceState): void
  onPaneResourceRetained(paneKey: string, owner: string, retained: boolean): void
}
interface PaneAccountOwner {
  ownershipKey: string
  sessions: Map<string, { retire(releaseResources: boolean): void }>
}
const paneAccountOwners = new WeakMap<
  ReturnType<typeof createWorkspaceTabsSession>,
  Map<string, PaneAccountOwner>
>()
/** Own right-workspace data and transitions; UI subscribes to its real panel snapshot. */
export function createDesktopPaneWorkspaceSession(
  state: DesktopPaneWorkspaceState,
  initialSessionKey: string,
  initialBrowserSequence: number
) {
  let input: DesktopPaneWorkspaceInput | null = null
  let retired = false
  let accountOwner: PaneAccountOwner | null = null
  let stopTabs: (() => void) | null = null
  let stopPaneOwner: (() => void) | null = null
  const isHeld = () => {
    if (retired || !input) return false
    if (input.tabs && input.workspaceTabId) {
      const actual = input.tabs.getSessionSnapshot()
      return (
        paneAccountOwners.get(input.tabs)?.get(input.workspaceTabId) === accountOwner &&
        actual.active &&
        actual.state.tabs.some(tab => tab.id === input?.workspaceTabId) &&
        input.workspaceSource.hasPane(input.paneKey)
      )
    }
    return observers > 0
  }
  let committedPanels: DesktopPanePanelProjectionInput | null = null
  let sessionKey = initialSessionKey
  let observers = 0
  let version = 0
  let scheduled = false
  let stopLaunch: (() => void) | null = null
  let viewed: {
    register: RuntimeInteractionsValue['registerView']
    owner: string
    id: string | null
  } | null = null
  let restoredReview = state.getSnapshot().reviewState.loading
    ? state.getSnapshot().reviewState
    : null
  let stopState: (() => void) | null = null
  let previousState: DesktopPaneWorkspaceSnapshot | null = null
  let previousOwner: DesktopPaneWorkspaceInput | null = null
  let previousRetained = false
  let previousActiveBrowser: string | null = null
  let harnessServices: WorkbenchServices | null = null
  let previousHarnessScope: string | null = null
  const scopeSignature = (value: DesktopPaneWorkspaceInput) =>
    JSON.stringify([
      value.ownershipKey,
      value.paneKey,
      value.currentRuntimeTask,
      value.activeBottomPanelContext.currentProject?.id,
      value.activeBottomPanelContext.workspaceTarget,
    ])
  let previousReady = false
  let previousReadySource: string | null = null
  let previousEnvironmentDocked: boolean | undefined
  let previousTask: RuntimeTaskAddress | null | undefined
  const inputs = () => {
    if (!input) throw new Error('Pane workspace is not committed')
    return input
  }
  const subagents = createDesktopPaneSubagents(state)
  const initialPanelSnapshot = state.getSnapshot()
  const resources = {
    centralHarnessRequestIdRef: { current: 0 },
    pendingModelRetryRef: { current: null as WorkbenchMessage | null },
    restoreEnvironmentInfoAfterSubagentsRef: { current: false },
    reviewRequestSequence: { current: 0 },
    previousTurnReviewRef: {
      current: null as {
        loadDiff: () => Promise<string>
        defaultFileTreeVisible?: boolean
        sourceSubtaskId?: string
      } | null,
    },
    terminalTabSequence: {
      current: Math.max(
        0,
        ...initialPanelSnapshot.rightPanelTabs
          .filter(isRightWorkspaceTerminalTab)
          .map(getRightWorkspaceTerminalNumericSuffix),
        isRightWorkspaceTerminalTab(initialPanelSnapshot.rightPanelView)
          ? getRightWorkspaceTerminalNumericSuffix(initialPanelSnapshot.rightPanelView)
          : 0
      ),
    },
    browserTabSequence: { current: initialBrowserSequence },
    temporaryChatTabSequence: { current: 0 },
    smartAppDevelopmentPreviewRequestsRef: { current: new Map<RightWorkspaceBrowserTab, number>() },
    recentBrowserPopupRequestsRef: { current: new Map<string, number>() },
    temporaryChatInitialInputsRef: { current: new Map<RightWorkspaceChatTab, string>() },
    routedBrowserOpenRequestIdRef: { current: null as string | null },
    rightPanelExtensionTabsRef: {
      get current() {
        return state.getSnapshot().rightPanelExtensionTabs
      },
    },
    browserStatesRef: {
      get current() {
        return state.getSnapshot().browserStates
      },
      set current(value: DesktopPaneWorkspaceSnapshot['browserStates']) {
        state.setBrowserStates(value)
      },
    },
    localHarnessModelApiRef: {
      get current() {
        return input?.services.localHarnessModelApi
      },
    },
    localDecisionRouterApiRef: {
      get current() {
        return input?.services.localDecisionRouterApi
      },
    },
    paneKeyRef: {
      get current() {
        return input?.paneKey ?? ''
      },
    },
    paneActiveRef: {
      get current() {
        return input?.paneActive ?? false
      },
    },
    paneMessagesRef: {
      get current() {
        return input?.paneMessages ?? []
      },
    },
    feedbackDialogRequestRef: {
      get current() {
        return inputs().feedbackDialogRequest
      },
    },
    activeBottomPanelContextRef: {
      get current() {
        return inputs().activeBottomPanelContext
      },
    },
    extensionStateListenersRef: { current: new Set<() => void>() },
  }
  const sidebarService = createDesktopPaneSidebarService(state)
  const browserService = createDesktopPaneBrowserService(state, resources)
  function retire(releaseResources: boolean) {
    if (retired) return
    retired = true
    state.retire()
    resources.centralHarnessRequestIdRef.current += 1
    resources.reviewRequestSequence.current += 1
    for (const [tab, id] of resources.smartAppDevelopmentPreviewRequestsRef.current)
      resources.smartAppDevelopmentPreviewRequestsRef.current.set(tab, id + 1)
    subagents.suspend()
    browserService.suspend()
    sidebarService.suspend()
    stopLaunch?.()
    stopLaunch = null
    viewed?.register(viewed.owner, null)
    viewed = null
    if (releaseResources) browserService.disposePreviews()
    stopState?.()
    stopState = null
    stopTabs?.()
    stopTabs = null
    stopPaneOwner?.()
    stopPaneOwner = null
    previousOwner?.onPaneResourceRetained(previousOwner.paneKey, 'right-panel', false)
    previousOwner = null
    if (input?.tabs && input.workspaceTabId && accountOwner) {
      if (accountOwner.sessions.get(input.paneKey)?.retire === retire)
        accountOwner.sessions.delete(input.paneKey)
      const owners = paneAccountOwners.get(input.tabs)
      if (!accountOwner.sessions.size && owners?.get(input.workspaceTabId) === accountOwner)
        owners.delete(input.workspaceTabId)
    }
  }
  function checkLifetime() {
    if (!isHeld()) retire(true)
    else reconcile()
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (isHeld()) reconcile()
    })
  }
  function reconcile() {
    if (!input || !isHeld()) return
    if (sessionKey !== input.rightPanelSessionKey) {
      sessionKey = input.rightPanelSessionKey
      resources.reviewRequestSequence.current += 1
      resources.previousTurnReviewRef.current = null
      input.setHasPreviousTurnReview(false)
      const snapshot = state.getSnapshot()
      state.replaceSnapshot({
        ...snapshot,
        rightPanelView: 'launcher',
        rightPanelTabs: [],
        rightPanelExpanded: false,
        selectedAssistantPlan: null,
        reviewState: { loading: false, diff: '' },
      })
    }
    const harnessScope = scopeSignature(input)
    if (
      previousHarnessScope !== null &&
      (previousHarnessScope !== harnessScope || harnessServices !== input.services)
    ) {
      resources.centralHarnessRequestIdRef.current += 1
      resources.pendingModelRetryRef.current = null
      state.setCentralHarnessStarting(false)
      state.setCentralHarnessError(null)
    }
    previousHarnessScope = harnessScope
    harnessServices = input.services
    const snapshot = state.getSnapshot()
    const retained =
      snapshot.fileWorkspaceDirty ||
      snapshot.rightPanelTabs.some(
        tab =>
          isRightWorkspaceTerminalTab(tab) ||
          isRightWorkspaceBrowserTab(tab) ||
          isRightWorkspaceHarnessTab(tab) ||
          isQuestionDiscussionTab(tab)
      )
    if (
      previousOwner?.onPaneResourceRetained !== input.onPaneResourceRetained ||
      previousOwner?.paneKey !== input.paneKey ||
      retained !== previousRetained
    ) {
      if (
        previousOwner &&
        (previousOwner.onPaneResourceRetained !== input.onPaneResourceRetained ||
          previousOwner.paneKey !== input.paneKey)
      )
        previousOwner.onPaneResourceRetained(previousOwner.paneKey, 'right-panel', false)
      input.onPaneResourceRetained(input.paneKey, 'right-panel', retained)
      previousRetained = retained
    }
    if (
      snapshot !== previousState ||
      input.onWorkspaceStateChange !== previousOwner?.onWorkspaceStateChange ||
      input.paneKey !== previousOwner?.paneKey ||
      input.sourceBrowserLabel !== previousOwner?.sourceBrowserLabel
    ) {
      input.onWorkspaceStateChange(input.paneKey, {
        ...snapshot,
        sourceBrowserLabel: input.sourceBrowserLabel,
      })
    }
    if (
      snapshot.rightPanelExtensionTabs !== previousState?.rightPanelExtensionTabs ||
      snapshot.rightPanelOpen !== previousState?.rightPanelOpen ||
      snapshot.rightPanelView !== previousState?.rightPanelView
    ) {
      for (const listener of resources.extensionStateListenersRef.current) listener()
    }
    previousState = snapshot
    previousOwner = input
    const activeBrowser =
      input.paneActive &&
      input.paneVisible &&
      input.workbenchVisible &&
      snapshot.rightPanelOpen &&
      isRightWorkspaceBrowserTab(snapshot.rightPanelView)
        ? (snapshot.browserStates[snapshot.rightPanelView]?.label ?? null)
        : null
    const activeBrowserKey = activeBrowser
      ? JSON.stringify([input.sourceBrowserLabel, activeBrowser])
      : null
    if (activeBrowserKey !== previousActiveBrowser) {
      previousActiveBrowser = activeBrowserKey
      if (activeBrowser) {
        const labels = new Set([input.sourceBrowserLabel, DEFAULT_EMBEDDED_BROWSER_LABEL])
        for (const label of labels)
          void setEmbeddedBrowserActiveTab(label, activeBrowser).catch(error =>
            console.error('Failed to synchronize active embedded browser tab:', error)
          )
      }
    }
    if (
      input.startupSurfaceReady &&
      (!previousReady || previousReadySource !== input.startupSurfaceSource) &&
      isElectronRuntime() &&
      getDesktopWindowLabel() === 'main'
    ) {
      console.info('[startup][renderer]', { step: 'workbench-surface-ready', status: 'completed' })
      void invokeDesktopHost<void>('renderer.startupReady', { source: input.startupSurfaceSource })
        .then(() =>
          console.info('[startup][renderer]', {
            step: 'startup-ready-notification',
            status: 'completed',
          })
        )
        .catch(error => console.error('[Wework] Failed to reveal the ready workbench', error))
    }
    previousReady = input.startupSurfaceReady
    previousReadySource = input.startupSurfaceSource
    // Closing the last tab can publish before layout commits its new docking mode.
    if (
      !snapshot.rightPanelOpen &&
      !input.environmentInfoLayoutRightPanelOpen &&
      resources.restoreEnvironmentInfoAfterSubagentsRef.current
    ) {
      resources.restoreEnvironmentInfoAfterSubagentsRef.current = false
      input.setEnvironmentInfoOpen(true)
    }
    if (
      previousEnvironmentDocked !== input.environmentInfoDocked ||
      previousTask !== input.currentRuntimeTask
    ) {
      previousEnvironmentDocked = input.environmentInfoDocked
      previousTask = input.currentRuntimeTask
      if (!input.currentRuntimeTask || input.environmentInfoDocked)
        input.onEnvironmentOverlayDismiss()
    }
    const active =
      input.paneActive &&
      input.paneVisible &&
      input.workbenchVisible &&
      (!input.tabs ||
        !input.workspaceTabId ||
        input.tabs.getSessionSnapshot().state.activeTabId === input.workspaceTabId)
    if (observers) sidebarService.reconcile({ ...input.sidebar, active })
    else sidebarService.suspend()
    const viewId = active && observers > 0 ? input.viewedInteractionId : null
    if (
      viewed?.register !== input.registerInteractionView ||
      viewed?.owner !== input.interactionViewOwner ||
      viewed?.id !== viewId
    ) {
      viewed?.register(viewed.owner, null)
      viewed = input.registerInteractionView
        ? { register: input.registerInteractionView, owner: input.interactionViewOwner, id: viewId }
        : null
      viewed?.register(viewed.owner, viewed.id)
    }
    if (restoredReview) {
      const restored = restoredReview
      restoredReview = null
      if (restored.reloadDiff) void input.openReviewFromDiffLoader(restored.reloadDiff, restored)
    }
    if (active && observers > 0 && input.workspaceLaunchDeviceId && input.workspaceLaunchPath) {
      const launch = consumeWorkbenchWorkspaceLaunch(
        input.workspaceLaunchDeviceId,
        input.workspaceLaunchPath,
        input.currentRuntimeTask?.taskId,
        {
          ownershipKey: input.ownershipKey,
          workspaceTabId: input.workspaceTabId,
          paneKey: input.paneKey,
        }
      )
      if (launch) {
        if (launch.initialInput) input.replacePaneInput(launch.initialInput)
        if (launch.rightSidebarTab)
          rightWorkspaceDshSidebar.openTab(
            { type: launch.rightSidebarTab.type },
            input.sidebar.scope
          )
        if (launch.openFile) {
          const { path, options } = launch.openFile
          const accepted = input
          queueMicrotask(() => {
            if (
              isHeld() &&
              input?.paneKey === accepted.paneKey &&
              input.workspaceLaunchDeviceId === accepted.workspaceLaunchDeviceId &&
              input.workspaceLaunchPath === accepted.workspaceLaunchPath
            )
              void input.openWorkspaceFileFromMessage(path, options)
          })
        }
      }
    }
    if (observers) subagents.reconcile(input)
    browserService.reconcile({
      ...input.browser,
      active:
        input.browser.active &&
        (!input.tabs ||
          !input.workspaceTabId ||
          input.tabs.getSessionSnapshot().state.activeTabId === input.workspaceTabId),
    })
  }
  return {
    resources,
    state,
    closeWorkspaceTabs: browserService.closeWorkspaceTabs,
    isHeld,
    allocateBrowserTab(): RightWorkspaceBrowserTab {
      return `browser:${++resources.browserTabSequence.current}`
    },
    allocateTerminalTab(): RightWorkspaceTerminalTab {
      return `terminal:${++resources.terminalTabSequence.current}`
    },
    allocateChatTab(): RightWorkspaceChatTab {
      return `chat:${Date.now()}-${++resources.temporaryChatTabSequence.current}`
    },
    nextReviewRequest() {
      return ++resources.reviewRequestSequence.current
    },
    isReviewRequestCurrent(id: number) {
      return resources.reviewRequestSequence.current === id
    },
    cancelHarnessLaunch() {
      resources.centralHarnessRequestIdRef.current += 1
    },
    clearPendingModelRetry() {
      resources.pendingModelRetryRef.current = null
    },
    takePendingModelRetry() {
      const message = resources.pendingModelRetryRef.current
      resources.pendingModelRetryRef.current = null
      return message
    },
    captureScope() {
      const accepted = inputs()
      const key = scopeSignature(accepted)
      const task = accepted.currentRuntimeTask
      const issueContext = (address: RuntimeTaskAddress) =>
        JSON.stringify([address.issueExecution, address.projectSession])
      const isOwnerCurrent = () =>
        isHeld() &&
        input?.services === accepted.services &&
        input.paneKey === accepted.paneKey &&
        input.ownershipKey === accepted.ownershipKey
      return {
        isCurrent: () => isOwnerCurrent() && scopeSignature(inputs()) === key,
        isConversationCurrentOnDevice: (deviceId: string) => {
          const current = input?.currentRuntimeTask
          return Boolean(
            isOwnerCurrent() &&
            task &&
            current &&
            current.deviceId === task.deviceId &&
            current.taskId === task.taskId &&
            resolveLocalWorkbenchDeviceId(
              accepted.activeBottomPanelContext.devices,
              task.deviceId
            ) === deviceId &&
            issueContext(current) === issueContext(task)
          )
        },
      }
    },
    observe(next: DesktopPaneWorkspaceInput) {
      let base: DesktopPaneWorkspaceSnapshot | null = null
      let projected: DesktopPaneWorkspaceSnapshot
      function read() {
        const snapshot = state.getSnapshot()
        if (base !== snapshot) {
          base = snapshot
          projected = projectDesktopPanePanels(snapshot, committedPanels, next)
        }
        return projected
      }
      return {
        getSnapshot: read,
        subscribe(listener: () => void) {
          input = next
          retired = false
          if (next.tabs && next.workspaceTabId) {
            let owners = paneAccountOwners.get(next.tabs)
            if (!owners) {
              owners = new Map()
              paneAccountOwners.set(next.tabs, owners)
            }
            let group = owners.get(next.workspaceTabId)
            if (group && group.ownershipKey !== next.ownershipKey) {
              owners.delete(next.workspaceTabId)
              for (const previous of [...group.sessions.values()]) previous.retire(true)
              group = undefined
            }
            if (!group) {
              group = { ownershipKey: next.ownershipKey, sessions: new Map() }
              owners.set(next.workspaceTabId, group)
            }
            if (accountOwner !== group) {
              const previous = group.sessions.get(next.paneKey)
              previous?.retire(false)
              owners.set(next.workspaceTabId, group)
              accountOwner = group
              group.sessions.set(next.paneKey, { retire })
            }
          }
          if (!stopTabs && next.tabs) stopTabs = next.tabs.subscribeSession(checkLifetime)
          if (!stopPaneOwner)
            stopPaneOwner = next.workspaceSource.subscribePaneOwners(checkLifetime)
          const projectedSnapshot = read()
          committedPanels = next
          observers += 1
          if (isHeld()) state.activate()
          else state.retire()
          version += 1
          const unsubscribe = state.subscribe(listener)
          if (!stopState) stopState = state.subscribe(schedule)
          if (!stopLaunch) stopLaunch = subscribeWorkbenchWorkspaceLaunch(schedule)
          state.replaceSnapshot(projectedSnapshot)
          reconcile()
          return () => {
            unsubscribe()
            observers -= 1
            const closed = ++version
            queueMicrotask(() => {
              if (closed !== version || observers) return
              subagents.suspend()
              viewed?.register(viewed.owner, null)
              viewed = null
              sidebarService.suspend()
              if (!isHeld()) retire(true)
            })
          }
        },
      }
    },
  }
}
export type DesktopPaneWorkspaceSession = ReturnType<typeof createDesktopPaneWorkspaceSession>
