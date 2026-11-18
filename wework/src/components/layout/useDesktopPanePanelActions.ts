import type { WorkbenchMessage } from '@/types/workbench'
import type { DesktopWorkbenchPaneProps } from './desktopWorkbenchMainHelpers'
import { useDesktopPaneBrowserActions } from './useDesktopPaneBrowserActions'
import {
  isQuestionDiscussionTab,
  useQuestionDiscussionPanels,
} from '@/features/notifications/questionDiscussion'
import { getMcpAppPanel, isMcpAppPanelTab } from '@/features/mcp-apps/workspacePanels'
import { conversationTerminals } from './backgroundTerminals'
import type { BackgroundTerminal } from './backgroundTerminals'
import { isWorkspaceFileTab } from './workspace-panels/workspaceFileTabs'
import { type MouseEvent as ReactMouseEvent, useCallback, useMemo } from 'react'
import type { AssistantPlanOpenRequest } from '@/components/chat/AssistantPlanCard'
import type { WorkspaceFileOpenRequest, WorkspaceTarget } from '@/types/workspace-files'
import { track } from '@/telemetry/client'
import {
  type RightWorkspaceBrowserTab,
  type RightWorkspaceChatTab,
  type RightWorkspacePanelTab,
  type RightWorkspacePanelHandle,
} from './workspace-panels/RightWorkspacePanel'
import {
  encodeRightWorkspaceExtensionTabId,
  isRightWorkspaceExtensionTab,
  rightWorkspaceDshSidebar,
  titleOfWeworkWorkspaceSidebarTab,
  type WeworkWorkspaceSidebarOpenTabSeed,
  type WeworkWorkspaceScope,
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './workspace-panels/rightWorkspaceDshSidebar'
import { focusComposerAtEnd } from '@/lib/workbenchComposerFocus'
import { closeEmbeddedBrowser } from '@/lib/embedded-browser'
import { type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import type { RuntimeTaskAddress } from '@/types/api'
import type { SubagentBlock } from '@/types/workbench'
import { stopHarnessAppDevelopmentRuntime } from '@/features/harness-apps/harnessAppDevelopmentRuntime'
import { harnessAppsApi } from '@/api/local/harnessApps'
import {
  CONVERSATION_COMPOSER_FOCUS_EXCLUSION_SELECTOR,
  rightPanelTabType,
  isRightWorkspaceBrowserTab,
  isRightWorkspaceHarnessTab,
  getRightWorkspaceHarnessSessionId,
} from './desktopWorkbenchMainHelpers'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { TFunction } from 'i18next'
import type { Dispatch, SetStateAction, RefObject } from 'react'
import type {
  DesktopPaneWorkspaceState,
  DesktopPaneWorkspaceSnapshot,
} from './desktopPaneWorkspaceState'
import type { DesktopPaneWorkspaceSession } from './desktopPaneWorkspaceSession'
interface Input {
  workbenchVisible: DesktopWorkbenchPaneProps['workbenchVisible']
  onPaneResourceRetained: DesktopWorkbenchPaneProps['onPaneResourceRetained']
  onLocalHarnessSessionClose: DesktopWorkbenchPaneProps['onLocalHarnessSessionClose']
  paneActive: boolean
  paneVisible: boolean
  services: WorkbenchServices
  workspaceTabId: string | undefined
  t: TFunction<'common'>
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProject: WorkbenchPaneIdentity['currentProject']
  paneKey: string
  currentRuntimeConversationSource: RuntimeTaskAddress | null
  issueExecutionReadOnly: boolean
  runtimeWorkApi: WorkbenchServices['runtimeWorkApi']
  questionPanels: ReturnType<typeof useQuestionDiscussionPanels>
  rightPanelExtensionTabsRef: DesktopPaneWorkspaceSession['resources']['rightPanelExtensionTabsRef']
  browserStatesRef: DesktopPaneWorkspaceSession['resources']['browserStatesRef']
  restoreEnvironmentInfoAfterSubagentsRef: DesktopPaneWorkspaceSession['resources']['restoreEnvironmentInfoAfterSubagentsRef']
  allocateTerminalTab: DesktopPaneWorkspaceSession['allocateTerminalTab']
  allocateChatTab: DesktopPaneWorkspaceSession['allocateChatTab']
  smartAppDevelopmentPreviewRequestsRef: DesktopPaneWorkspaceSession['resources']['smartAppDevelopmentPreviewRequestsRef']
  temporaryChatInitialInputsRef: DesktopPaneWorkspaceSession['resources']['temporaryChatInitialInputsRef']
  rightPanelView: DesktopPaneWorkspaceSnapshot['rightPanelView']
  rightPanelTabs: DesktopPaneWorkspaceSnapshot['rightPanelTabs']
  browserStates: DesktopPaneWorkspaceSnapshot['browserStates']
  setRightPanelOpen: DesktopPaneWorkspaceState['setRightPanelOpen']
  setRightPanelExpanded: DesktopPaneWorkspaceState['setRightPanelExpanded']
  setRightPanelView: DesktopPaneWorkspaceState['setRightPanelView']
  setRightPanelTabs: DesktopPaneWorkspaceState['setRightPanelTabs']
  setSelectedAssistantPlan: DesktopPaneWorkspaceState['setSelectedAssistantPlan']
  setSelectedSubagentConversationId: DesktopPaneWorkspaceState['setSelectedSubagentConversationId']
  setRightPanelExtensionTabs: DesktopPaneWorkspaceState['setRightPanelExtensionTabs']
  setTemporaryChatAddresses: DesktopPaneWorkspaceState['setTemporaryChatAddresses']
  setFileTabs: DesktopPaneWorkspaceState['setFileTabs']
  setBrowserStates: DesktopPaneWorkspaceState['setBrowserStates']
  setConversationSelectionInsertion: Dispatch<SetStateAction<{ id: number; text: string } | null>>
  setBottomPanelOpenByKey: Dispatch<SetStateAction<Record<string, boolean>>>
  setOpenFileRequest: Dispatch<SetStateAction<WorkspaceFileOpenRequest | null>>
  rightWorkspacePanelRef: RefObject<RightWorkspacePanelHandle | null>
  environmentInfoDocked: boolean
  environmentInfoOpen: boolean
  setEnvironmentInfoOpen: (open: boolean) => void
  effectiveRightPanelTabs: RightWorkspacePanelTab[]
  workspacePanelTarget: WorkspaceTarget | null
  bottomPanelWorkspaceKey: string
  rememberActiveBottomPanelContext: () => void
  paneMessages: WorkbenchMessage[]
  updateBrowserState: ReturnType<typeof useDesktopPaneBrowserActions>['updateBrowserState']
  syncActiveEmbeddedBrowserLabel: ReturnType<
    typeof useDesktopPaneBrowserActions
  >['syncActiveEmbeddedBrowserLabel']
  openBrowserTab: ReturnType<typeof useDesktopPaneBrowserActions>['openBrowserTab']
  closeSmartAppDevelopmentPreviewBrowser: ReturnType<
    typeof useDesktopPaneBrowserActions
  >['closeSmartAppDevelopmentPreviewBrowser']
  loadSmartAppDevelopmentPreview: ReturnType<
    typeof useDesktopPaneBrowserActions
  >['loadSmartAppDevelopmentPreview']
}
export function useDesktopPanePanelActions({
  workbenchVisible,
  onPaneResourceRetained,
  onLocalHarnessSessionClose,
  paneActive,
  paneVisible,
  services,
  workspaceTabId,
  t,
  currentRuntimeTask,
  currentProject,
  paneKey,
  currentRuntimeConversationSource,
  issueExecutionReadOnly,
  runtimeWorkApi,
  questionPanels,
  rightPanelExtensionTabsRef,
  browserStatesRef,
  restoreEnvironmentInfoAfterSubagentsRef,
  allocateTerminalTab,
  allocateChatTab,
  smartAppDevelopmentPreviewRequestsRef,
  temporaryChatInitialInputsRef,
  rightPanelView,
  rightPanelTabs,
  browserStates,
  setRightPanelOpen,
  setRightPanelExpanded,
  setRightPanelView,
  setRightPanelTabs,
  setSelectedAssistantPlan,
  setSelectedSubagentConversationId,
  setRightPanelExtensionTabs,
  setTemporaryChatAddresses,
  setFileTabs,
  setBrowserStates,
  setConversationSelectionInsertion,
  setBottomPanelOpenByKey,
  setOpenFileRequest,
  rightWorkspacePanelRef,
  environmentInfoDocked,
  environmentInfoOpen,
  setEnvironmentInfoOpen,
  effectiveRightPanelTabs,
  workspacePanelTarget,
  bottomPanelWorkspaceKey,
  rememberActiveBottomPanelContext,
  paneMessages,
  updateBrowserState,
  syncActiveEmbeddedBrowserLabel,
  openBrowserTab,
  closeSmartAppDevelopmentPreviewBrowser,
  loadSmartAppDevelopmentPreview,
}: Input) {
  const openRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
      setRightPanelView(tab)
    },
    [setRightPanelOpen, setRightPanelTabs, setRightPanelView]
  )
  const backgroundTerminals = useMemo(
    () => conversationTerminals(paneMessages, currentRuntimeTask?.taskId ?? paneKey),
    [paneMessages, currentRuntimeTask?.taskId, paneKey]
  )
  const runningBackgroundTerminals = backgroundTerminals.filter(terminal => terminal.background)
  const openBackgroundTerminal = useCallback(
    (terminal: BackgroundTerminal) => {
      if (environmentInfoOpen && !environmentInfoDocked) setEnvironmentInfoOpen(false)
      openRightPanelTab(terminal.tabId)
    },
    [environmentInfoOpen, environmentInfoDocked, setEnvironmentInfoOpen, openRightPanelTab]
  )
  const stopBackgroundTerminals =
    currentRuntimeTask && runtimeWorkApi?.cleanRuntimeBackgroundTerminals && !issueExecutionReadOnly
      ? async () => {
          const response = await runtimeWorkApi.cleanRuntimeBackgroundTerminals!(currentRuntimeTask)
          if (!response.success)
            throw new Error(response.error || 'Unable to stop background terminals')
        }
      : undefined
  const openSubagentConversation = useCallback(
    (block: SubagentBlock) => {
      if (environmentInfoOpen) {
        restoreEnvironmentInfoAfterSubagentsRef.current = true
        setEnvironmentInfoOpen(false)
      }
      setSelectedSubagentConversationId(block.agentThreadId ?? block.agentId ?? block.id)
      openRightPanelTab('subagents')
    },
    [
      environmentInfoOpen,
      openRightPanelTab,
      restoreEnvironmentInfoAfterSubagentsRef,
      setEnvironmentInfoOpen,
      setSelectedSubagentConversationId,
    ]
  )
  const openSubagentOverview = useCallback(() => {
    restoreEnvironmentInfoAfterSubagentsRef.current = true
    if (environmentInfoOpen) setEnvironmentInfoOpen(false)
    setSelectedSubagentConversationId(null)
    openRightPanelTab('subagents')
  }, [
    environmentInfoOpen,
    openRightPanelTab,
    restoreEnvironmentInfoAfterSubagentsRef,
    setEnvironmentInfoOpen,
    setSelectedSubagentConversationId,
  ])
  const rightWorkspaceExtensionSessionId = currentRuntimeConversationSource
    ? `${currentRuntimeConversationSource.deviceId}:${currentRuntimeConversationSource.taskId}`
    : paneKey
  const rightWorkspaceExtensionCwd =
    workspacePanelTarget?.path ??
    currentProject?.config?.workspace?.localPath ??
    currentProject?.config?.path
  const rightWorkspaceExtensionScope = useMemo<WeworkWorkspaceScope>(
    () => ({
      sessionId: rightWorkspaceExtensionSessionId,
      ...(rightWorkspaceExtensionCwd ? { cwd: rightWorkspaceExtensionCwd } : {}),
    }),
    [rightWorkspaceExtensionCwd, rightWorkspaceExtensionSessionId]
  )
  const openRightWorkspaceExtensionTab = useCallback(
    (seed: WeworkWorkspaceSidebarOpenTabSeed) => {
      const descriptor = rightWorkspaceDshSidebar.getTab(seed.type)
      if (!descriptor) return

      const currentTabs = Object.values(rightPanelExtensionTabsRef.current).filter(
        (state): state is RightWorkspaceExtensionTabState => Boolean(state)
      )
      const tab = {
        id: seed.id ?? descriptor.id,
        type: descriptor.id,
        title: seed.title ?? titleOfWeworkWorkspaceSidebarTab(descriptor, t),
        ...(seed.path || seed.url ? { path: seed.path ?? seed.url } : {}),
        ...(seed.diff !== undefined ? { diff: seed.diff } : {}),
        ...(seed.meta !== undefined ? { meta: seed.meta } : {}),
      }
      const existing = currentTabs.find(candidate => candidate.tab.id === tab.id)
      if (existing) {
        openRightPanelTab(existing.internalId)
        return
      }

      const internalId = encodeRightWorkspaceExtensionTabId(tab.id)
      setRightPanelExtensionTabs(current => ({
        ...current,
        [internalId]: { internalId, tab },
      }))
      openRightPanelTab(internalId)
    },
    [openRightPanelTab, rightPanelExtensionTabsRef, setRightPanelExtensionTabs, t]
  )
  const addSmartAppDevelopmentPlugin = useCallback(
    async (tab: RightWorkspaceBrowserTab, installationId: string, pluginSpec: string) => {
      const installations = await harnessAppsApi.list()
      const installation = installations.find(item => item.id === installationId)
      if (!installation) {
        throw new Error(t('workbench.smart_app_preview_not_found', '找不到要预览的智能工作台'))
      }
      await closeSmartAppDevelopmentPreviewBrowser(tab)
      updateBrowserState(tab, {
        developmentPreview: {
          installationId,
          displayName: installation.manifest.displayName,
          workspaceTabId:
            browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
          status: 'reloading',
          verificationStatus: 'unverified',
        },
      })
      try {
        if (installation.state === 'running') {
          await stopHarnessAppDevelopmentRuntime(
            installationId,
            services.localHarnessModelApi,
            services.localDecisionRouterApi
          )
        }
        await harnessAppsApi.addPlugin(installationId, pluginSpec)
        await loadSmartAppDevelopmentPreview(tab, installationId, false)
      } catch (error) {
        updateBrowserState(tab, {
          developmentPreview: {
            installationId,
            displayName: installation.manifest.displayName,
            workspaceTabId:
              browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
            status: 'ready',
            verificationStatus: 'unverified',
          },
        })
        throw error
      }
    },
    [
      browserStatesRef,
      closeSmartAppDevelopmentPreviewBrowser,
      loadSmartAppDevelopmentPreview,
      services.localDecisionRouterApi,
      services.localHarnessModelApi,
      t,
      updateBrowserState,
      workspaceTabId,
    ]
  )
  const selectRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelView(tab)
      if (isRightWorkspaceBrowserTab(tab)) {
        const activeBrowserLabel = browserStatesRef.current[tab]?.label
        if (activeBrowserLabel) syncActiveEmbeddedBrowserLabel(activeBrowserLabel)
      }
    },
    [browserStatesRef, setRightPanelOpen, setRightPanelView, syncActiveEmbeddedBrowserLabel]
  )
  const openTemporaryChatTab = useCallback(
    (initialInput?: string) => {
      const tab = allocateChatTab()
      if (initialInput) temporaryChatInitialInputsRef.current.set(tab, initialInput)
      openRightPanelTab(tab)
    },
    [openRightPanelTab, temporaryChatInitialInputsRef, allocateChatTab]
  )
  const addSelectionToConversation = useCallback(
    (selectedText: string) => {
      setConversationSelectionInsertion(current => ({
        id: (current?.id ?? 0) + 1,
        text: selectedText,
      }))
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]'
            )
            ?.focus()
        })
      })
    },
    [setConversationSelectionInsertion]
  )
  const askSelectionInSidebar = useCallback(
    (selectedText: string) => openTemporaryChatTab(selectedText),
    [openTemporaryChatTab]
  )
  const focusComposerFromConversationClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        !paneActive ||
        !paneVisible ||
        !workbenchVisible ||
        !(event.target instanceof Element) ||
        event.target.closest(CONVERSATION_COMPOSER_FOCUS_EXCLUSION_SELECTOR)
      ) {
        return
      }
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
      const composer = event.currentTarget.querySelector<HTMLElement>(
        '[data-testid="chat-message-input"][contenteditable="true"]'
      )
      if (!composer) return
      focusComposerAtEnd(composer)
    },
    [paneActive, paneVisible, workbenchVisible]
  )
  const openAssistantPlan = useCallback(
    (request: AssistantPlanOpenRequest) => {
      setSelectedAssistantPlan({
        blockId: request.blockId,
        subtaskId: request.subtaskId,
        fallbackContent: request.content,
      })
      openRightPanelTab('plan')
    },
    [openRightPanelTab, setSelectedAssistantPlan]
  )
  const closeRightPanelTab = (tab: RightWorkspacePanelTab) => {
    if (isQuestionDiscussionTab(tab)) questionPanels.close(tab)
    if (isMcpAppPanelTab(tab)) {
      const panel = getMcpAppPanel(tab)
      if (panel) {
        panel.dismiss()
        return
      }
    }
    const extensionState = isRightWorkspaceExtensionTab(tab)
      ? rightPanelExtensionTabsRef.current[tab]
      : undefined
    const browserState = isRightWorkspaceBrowserTab(tab) ? browserStates[tab] : null
    if (
      browserState?.hasActiveDownload &&
      !window.confirm(t('workbench.browser_close_browser_with_download_confirm'))
    ) {
      return
    }
    track('workspace_panel_removed', { panel: rightPanelTabType(tab) })
    if (tab.startsWith('chat:')) {
      temporaryChatInitialInputsRef.current.delete(tab as RightWorkspaceChatTab)
      setTemporaryChatAddresses(current => {
        if (!current[tab as RightWorkspaceChatTab]) return current
        const next = { ...current }
        delete next[tab as RightWorkspaceChatTab]
        return next
      })
    }
    if (isRightWorkspaceHarnessTab(tab)) {
      void onLocalHarnessSessionClose(getRightWorkspaceHarnessSessionId(tab))
    }
    if (tab === 'files') {
      setOpenFileRequest(null)
    }
    if (isWorkspaceFileTab(tab)) {
      setFileTabs(current => {
        const next = { ...current }
        delete next[tab]
        return next
      })
    }
    if (browserState?.developmentPreview) {
      smartAppDevelopmentPreviewRequestsRef.current.set(
        tab as RightWorkspaceBrowserTab,
        (smartAppDevelopmentPreviewRequestsRef.current.get(tab as RightWorkspaceBrowserTab) ?? 0) +
          1
      )
      void stopHarnessAppDevelopmentRuntime(
        browserState.developmentPreview.installationId,
        services.localHarnessModelApi,
        services.localDecisionRouterApi
      ).catch(error => {
        console.error('Failed to stop closed Smart app development preview:', error)
      })
    }
    if (browserState?.label) {
      void closeEmbeddedBrowser(browserState.label, browserState.nativeLabel ?? undefined).catch(
        error => {
          console.error('Failed to close embedded browser tab:', error)
        }
      )
    }
    if (isRightWorkspaceBrowserTab(tab)) {
      setBrowserStates(current => {
        if (!current[tab]) return current
        const next = { ...current }
        delete next[tab]
        return next
      })
    }
    if (extensionState) {
      setRightPanelExtensionTabs(current => {
        if (!current[tab as RightWorkspaceExtensionTab]) return current
        const next = { ...current }
        delete next[tab as RightWorkspaceExtensionTab]
        return next
      })
    }
    const currentTabs = rightPanelTabs.includes(tab) ? rightPanelTabs : [...rightPanelTabs, tab]
    const nextTabs = currentTabs.filter(openTab => openTab !== tab)
    setRightPanelTabs(nextTabs)
    if (nextTabs.length === 0) {
      setRightPanelExpanded(false)
      setRightPanelOpen(false)
      setRightPanelView('launcher')
      return
    }
    if (tab === 'subagents' && restoreEnvironmentInfoAfterSubagentsRef.current) {
      restoreEnvironmentInfoAfterSubagentsRef.current = false
      setEnvironmentInfoOpen(true)
    }
    if (rightPanelView === tab) {
      setRightPanelView(nextTabs[nextTabs.length - 1])
    }
  }
  const selectBrowserView = useCallback(() => {
    openBrowserTab()
  }, [openBrowserTab])
  const selectTerminalView = useCallback(() => {
    openRightPanelTab(allocateTerminalTab())
  }, [allocateTerminalTab, openRightPanelTab])
  const selectChatView = useCallback(() => {
    openTemporaryChatTab()
  }, [openTemporaryChatTab])
  const navigateRightWorkspace = useCallback(
    (action: () => void) => {
      if (rightWorkspacePanelRef.current) rightWorkspacePanelRef.current.navigate(action)
      else action()
    },
    [rightWorkspacePanelRef]
  )
  const selectPlanView = useCallback(() => {
    openRightPanelTab('plan')
  }, [openRightPanelTab])
  const toggleRightPanel = () => {
    setRightPanelOpen(open => {
      const nextOpen = !open
      if (nextOpen) {
        setRightPanelView(current =>
          effectiveRightPanelTabs.includes(current as RightWorkspacePanelTab) ? current : 'launcher'
        )
      } else {
        setRightPanelExpanded(false)
      }
      return nextOpen
    })
  }
  const toggleRightPanelExpanded = () => {
    setRightPanelExpanded(expanded => !expanded)
  }
  const toggleBottomPanel = () => {
    rememberActiveBottomPanelContext()
    onPaneResourceRetained(paneKey, 'bottom-panel', true)
    setBottomPanelOpenByKey(current => {
      const open = current[bottomPanelWorkspaceKey] ?? false
      return { ...current, [bottomPanelWorkspaceKey]: !open }
    })
  }
  const openTerminalPanel = () => {
    toggleBottomPanel()
  }
  const closeBottomPanelContext = useCallback(
    (key: string) => {
      setBottomPanelOpenByKey(current => ({ ...current, [key]: false }))
    },
    [setBottomPanelOpenByKey]
  )
  const handleTerminalTabsEmpty = () => {
    onPaneResourceRetained(paneKey, 'bottom-panel', false)
  }
  return {
    openRightPanelTab,
    backgroundTerminals,
    runningBackgroundTerminals,
    openBackgroundTerminal,
    stopBackgroundTerminals,
    openSubagentConversation,
    openSubagentOverview,
    rightWorkspaceExtensionScope,
    openRightWorkspaceExtensionTab,
    addSmartAppDevelopmentPlugin,
    selectRightPanelTab,
    addSelectionToConversation,
    askSelectionInSidebar,
    focusComposerFromConversationClick,
    openAssistantPlan,
    closeRightPanelTab,
    selectBrowserView,
    selectTerminalView,
    selectChatView,
    navigateRightWorkspace,
    selectPlanView,
    toggleRightPanel,
    toggleRightPanelExpanded,
    toggleBottomPanel,
    openTerminalPanel,
    closeBottomPanelContext,
    handleTerminalTabsEmpty,
  }
}
