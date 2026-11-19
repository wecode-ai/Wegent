let legacyEmbeddedBrowserOpenRequestSequence = 0
import { useCallback } from 'react'
import {
  type RightWorkspaceBrowserState,
  type RightWorkspaceBrowserTab,
} from './workspace-panels/RightWorkspacePanel'
import { type LocalHarnessId } from '@/lib/local-harness'
import { type LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import {
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  closeEmbeddedBrowser,
  setEmbeddedBrowserActiveTab,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { findBrowserTabByPopupParent } from '@/features/browser-tabs/browserPopupRouting'
import {
  restartHarnessAppDevelopmentRuntime,
  startHarnessAppDevelopmentRuntime,
  stopHarnessAppDevelopmentRuntime,
} from '@/features/harness-apps/harnessAppDevelopmentRuntime'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { getErrorMessage } from '@/lib/error-message'
import {
  smartAppDevelopmentVerificationStatus,
  isRightWorkspaceBrowserTab,
  logBrowserOpenDiagnostic,
  getRightWorkspaceBrowserLabelSuffix,
  browserLabelForRightWorkspaceTab,
} from './desktopWorkbenchMainHelpers'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { TFunction } from 'i18next'
import type {
  DesktopPaneWorkspaceState,
  DesktopPaneWorkspaceSnapshot,
} from './desktopPaneWorkspaceState'
import type { DesktopPaneWorkspaceSession } from './desktopPaneWorkspaceSession'
interface Input {
  services: WorkbenchServices
  workspaceTabId: string | undefined
  t: TFunction<'common'>
  defaultEmbeddedBrowserLabel: string
  browserStatesRef: DesktopPaneWorkspaceSession['resources']['browserStatesRef']
  allocateBrowserTab: DesktopPaneWorkspaceSession['allocateBrowserTab']
  smartAppDevelopmentPreviewRequestsRef: DesktopPaneWorkspaceSession['resources']['smartAppDevelopmentPreviewRequestsRef']
  rightPanelView: DesktopPaneWorkspaceSnapshot['rightPanelView']
  setRightPanelOpen: DesktopPaneWorkspaceState['setRightPanelOpen']
  setRightPanelView: DesktopPaneWorkspaceState['setRightPanelView']
  setRightPanelTabs: DesktopPaneWorkspaceState['setRightPanelTabs']
  setBrowserStates: DesktopPaneWorkspaceState['setBrowserStates']
  getHarnessModelOptions: (id: LocalHarnessId) => LocalHarnessModelOption[]
}
export function useDesktopPaneBrowserActions({
  services,
  workspaceTabId,
  t,
  defaultEmbeddedBrowserLabel,
  browserStatesRef,
  allocateBrowserTab,
  smartAppDevelopmentPreviewRequestsRef,
  rightPanelView,
  setRightPanelOpen,
  setRightPanelView,
  setRightPanelTabs,
  setBrowserStates,
  getHarnessModelOptions,
}: Input) {
  const updateBrowserState = useCallback(
    (tab: RightWorkspaceBrowserTab, update: Partial<RightWorkspaceBrowserState>) => {
      setBrowserStates(current => {
        const currentState = current[tab]
        if (!currentState) return current
        return {
          ...current,
          [tab]: {
            ...currentState,
            ...update,
          },
        }
      })
    },
    [setBrowserStates]
  )
  const createBrowserTabState = useCallback(
    (
      tab: RightWorkspaceBrowserTab,
      overrides: Partial<RightWorkspaceBrowserState> = {}
    ): RightWorkspaceBrowserState => ({
      label: browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab),
      browserSessionId: getRightWorkspaceBrowserLabelSuffix(tab),
      url: null,
      title: null,
      faviconUrl: null,
      isLoading: false,
      agentActive: false,
      hasActiveDownload: false,
      openRequest: null,
      ...overrides,
    }),
    [defaultEmbeddedBrowserLabel]
  )
  const syncActiveEmbeddedBrowserLabel = useCallback(
    (activeBrowserLabel: string) => {
      void setEmbeddedBrowserActiveTab(defaultEmbeddedBrowserLabel, activeBrowserLabel).catch(
        error => {
          console.error('Failed to synchronize active embedded browser tab:', error)
        }
      )
      if (defaultEmbeddedBrowserLabel !== DEFAULT_EMBEDDED_BROWSER_LABEL) {
        void setEmbeddedBrowserActiveTab(DEFAULT_EMBEDDED_BROWSER_LABEL, activeBrowserLabel).catch(
          error => {
            console.error('Failed to synchronize default embedded browser tab:', error)
          }
        )
      }
    },
    [defaultEmbeddedBrowserLabel]
  )
  const openBrowserTab = useCallback(
    (
      request?: EmbeddedBrowserOpenRequest | null,
      targetTab?: RightWorkspaceBrowserTab,
      overrides: Partial<RightWorkspaceBrowserState> = {}
    ) => {
      const tab = targetTab ?? allocateBrowserTab()
      logBrowserOpenDiagnostic('openBrowserTab', {
        tab,
        targetTab: targetTab ?? null,
        requestId: request?.id ?? null,
        url: request?.url ?? null,
        requestLabel: request?.label ?? null,
        requestTargetLabel: request?.targetLabel ?? null,
      })
      const existingState = browserStatesRef.current[tab]
      const stateLabel =
        overrides.label ??
        existingState?.label ??
        request?.targetLabel ??
        browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab)
      const normalizedRequest: EmbeddedBrowserOpenRequest | null = request
        ? {
            ...request,
            id: request.id || `legacy-open-request-${++legacyEmbeddedBrowserOpenRequestSequence}`,
            baseLabel: request.baseLabel || defaultEmbeddedBrowserLabel,
            source: request.source || 'user',
            disposition: request.disposition || 'current-tab',
            label: stateLabel,
            targetLabel: stateLabel,
          }
        : null

      setBrowserStates(current => {
        const currentState = current[tab]
        return {
          ...current,
          [tab]: currentState
            ? {
                ...currentState,
                ...overrides,
                openRequest: normalizedRequest ?? currentState.openRequest,
              }
            : createBrowserTabState(tab, {
                label: stateLabel,
                browserSessionId:
                  request?.browserSessionId ?? getRightWorkspaceBrowserLabelSuffix(tab),
                openRequest: normalizedRequest,
                ...overrides,
              }),
        }
      })
      setRightPanelOpen(true)
      setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
      setRightPanelView(tab)
      syncActiveEmbeddedBrowserLabel(stateLabel)
      return tab
    },
    [
      allocateBrowserTab,
      browserStatesRef,
      defaultEmbeddedBrowserLabel,
      setBrowserStates,
      setRightPanelOpen,
      setRightPanelTabs,
      setRightPanelView,
      syncActiveEmbeddedBrowserLabel,
      createBrowserTabState,
    ]
  )
  const closeSmartAppDevelopmentPreviewBrowser = useCallback(
    async (tab: RightWorkspaceBrowserTab) => {
      const browserState = browserStatesRef.current[tab]
      if (!browserState) return
      await closeEmbeddedBrowser(browserState.label, browserState.nativeLabel ?? undefined)
      updateBrowserState(tab, {
        nativeLabel: null,
        isLoading: false,
        openRequest: null,
      })
    },
    [browserStatesRef, updateBrowserState]
  )
  const loadSmartAppDevelopmentPreview = useCallback(
    async (
      tab: RightWorkspaceBrowserTab,
      installationId: string,
      reload: boolean,
      initialDisplayName?: string
    ): Promise<void> => {
      const requestId = (smartAppDevelopmentPreviewRequestsRef.current.get(tab) ?? 0) + 1
      smartAppDevelopmentPreviewRequestsRef.current.set(tab, requestId)
      if (reload) {
        await closeSmartAppDevelopmentPreviewBrowser(tab)
      }
      updateBrowserState(tab, {
        developmentPreview: {
          installationId,
          displayName:
            initialDisplayName ??
            browserStatesRef.current[tab]?.developmentPreview?.displayName ??
            t('workbench.smart_apps_title', '智能工作台'),
          workspaceTabId:
            browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
          status: reload ? 'reloading' : 'starting',
          verificationStatus: 'unverified',
        },
      })
      try {
        const installations = await harnessAppsApi.list()
        const installation = installations.find(item => item.id === installationId)
        if (!installation) {
          throw new Error(t('workbench.smart_app_preview_not_found', '找不到要预览的智能工作台'))
        }
        const modelOptions = getHarnessModelOptions('opencode')
        const missingWebUrlMessage = t(
          'workbench.smart_apps_missing_web_url',
          '智能工作台没有返回可用地址'
        )
        const running = reload
          ? await restartHarnessAppDevelopmentRuntime(
              installation,
              modelOptions,
              services.localHarnessModelApi,
              missingWebUrlMessage,
              services.localDecisionRouterApi
            )
          : await startHarnessAppDevelopmentRuntime({
              installation,
              modelOptions,
              localHarnessModelApi: services.localHarnessModelApi,
              localDecisionRouterApi: services.localDecisionRouterApi,
              missingWebUrlMessage,
            })
        if (
          smartAppDevelopmentPreviewRequestsRef.current.get(tab) !== requestId ||
          !browserStatesRef.current[tab]
        ) {
          await stopHarnessAppDevelopmentRuntime(
            installationId,
            services.localHarnessModelApi,
            services.localDecisionRouterApi
          ).catch(error => {
            console.error('Failed to stop closed Smart app development preview:', error)
          })
          return
        }
        const verificationReport = await harnessAppsApi
          .inspectVerification(installationId)
          .catch(error => {
            console.error('Failed to inspect Smart app verification report:', error)
            return null
          })
        if (smartAppDevelopmentPreviewRequestsRef.current.get(tab) !== requestId) return
        updateBrowserState(tab, {
          openRequest: {
            id: `smart-app-development-preview-${installationId}-${Date.now()}`,
            url: running.webUrl!,
            baseLabel: defaultEmbeddedBrowserLabel,
            source: 'user',
            disposition: 'current-tab',
            label: browserStatesRef.current[tab]?.label,
            targetLabel: browserStatesRef.current[tab]?.label,
            browserSessionId: browserStatesRef.current[tab]?.browserSessionId,
          },
          developmentPreview: {
            installationId,
            displayName: running.manifest.displayName,
            workspaceTabId:
              browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
            status: 'ready',
            verificationStatus: smartAppDevelopmentVerificationStatus(verificationReport),
            verificationReport,
          },
        })
      } catch (error) {
        if (smartAppDevelopmentPreviewRequestsRef.current.get(tab) !== requestId) return
        updateBrowserState(tab, {
          developmentPreview: {
            installationId,
            displayName:
              initialDisplayName ??
              browserStatesRef.current[tab]?.developmentPreview?.displayName ??
              t('workbench.smart_apps_title', '智能工作台'),
            workspaceTabId:
              browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
            status: 'error',
            verificationStatus: 'unverified',
            error: getErrorMessage(
              error,
              t('workbench.smart_app_preview_failed', 'DSH 开发预览启动失败')
            ),
          },
        })
      }
    },
    [
      browserStatesRef,
      closeSmartAppDevelopmentPreviewBrowser,
      defaultEmbeddedBrowserLabel,
      getHarnessModelOptions,
      services.localDecisionRouterApi,
      services.localHarnessModelApi,
      smartAppDevelopmentPreviewRequestsRef,
      t,
      updateBrowserState,
      workspaceTabId,
    ]
  )
  const reloadSmartAppDevelopmentPreview = useCallback(
    (tab: RightWorkspaceBrowserTab, installationId: string) => {
      void loadSmartAppDevelopmentPreview(tab, installationId, true)
    },
    [loadSmartAppDevelopmentPreview]
  )
  const verifySmartAppDevelopmentPreview = useCallback(
    (tab: RightWorkspaceBrowserTab, installationId: string) => {
      const preview = browserStatesRef.current[tab]?.developmentPreview
      if (!preview || preview.status !== 'ready') return
      updateBrowserState(tab, {
        developmentPreview: {
          ...preview,
          verificationStatus: 'running',
          verificationError: undefined,
        },
      })
      void harnessAppsApi
        .verify(installationId)
        .then(verificationReport => {
          const current = browserStatesRef.current[tab]?.developmentPreview
          if (!current || current.installationId !== installationId) return
          updateBrowserState(tab, {
            developmentPreview: {
              ...current,
              verificationStatus: smartAppDevelopmentVerificationStatus(verificationReport),
              verificationReport,
              verificationError: undefined,
            },
          })
        })
        .catch(error => {
          const current = browserStatesRef.current[tab]?.developmentPreview
          if (!current || current.installationId !== installationId) return
          updateBrowserState(tab, {
            developmentPreview: {
              ...current,
              verificationStatus: 'failed',
              verificationError: getErrorMessage(
                error,
                t('workbench.smart_app_preview_verification_failed')
              ),
            },
          })
        })
    },
    [browserStatesRef, t, updateBrowserState]
  )
  const routeEmbeddedBrowserOpenRequest = useCallback(
    (request: EmbeddedBrowserOpenRequest, assignedToPane = false) => {
      const states = browserStatesRef.current
      const targetByLabel = findBrowserTabByPopupParent(
        states,
        request.targetLabel ?? request.label
      )
      const requestBaseLabel = request.baseLabel || request.label || DEFAULT_EMBEDDED_BROWSER_LABEL
      const baseLabelMatchesPane =
        requestBaseLabel === defaultEmbeddedBrowserLabel ||
        (requestBaseLabel === DEFAULT_EMBEDDED_BROWSER_LABEL && assignedToPane) ||
        Boolean(targetByLabel)
      if (!baseLabelMatchesPane) {
        logBrowserOpenDiagnostic('routeRequestDropped', {
          requestId: request.id,
          url: request.url,
          reason: 'baseLabel-mismatch',
          requestBaseLabel,
          defaultEmbeddedBrowserLabel,
        })
        return
      }

      const source = request.source || 'agent'
      const disposition = request.disposition || 'current-tab'
      logBrowserOpenDiagnostic('routeRequest', {
        requestId: request.id,
        url: request.url,
        label: request.label ?? null,
        baseLabel: requestBaseLabel,
        source,
        disposition,
        targetByLabel: targetByLabel ?? null,
        defaultEmbeddedBrowserLabel,
      })
      const normalizedRequest: EmbeddedBrowserOpenRequest = {
        ...request,
        id: request.id || `legacy-open-request-${++legacyEmbeddedBrowserOpenRequestSequence}`,
        baseLabel: requestBaseLabel,
        source,
        disposition,
      }
      const opensNewBrowserTab =
        disposition === 'new-tab' || source === 'user' || source === 'popup'
      const activeBrowserTab = isRightWorkspaceBrowserTab(rightPanelView) ? rightPanelView : null

      openBrowserTab(
        normalizedRequest,
        opensNewBrowserTab ? undefined : (targetByLabel ?? activeBrowserTab ?? undefined)
      )
    },
    [browserStatesRef, defaultEmbeddedBrowserLabel, openBrowserTab, rightPanelView]
  )
  return {
    updateBrowserState,
    syncActiveEmbeddedBrowserLabel,
    openBrowserTab,
    closeSmartAppDevelopmentPreviewBrowser,
    loadSmartAppDevelopmentPreview,
    reloadSmartAppDevelopmentPreview,
    verifySmartAppDevelopmentPreview,
    routeEmbeddedBrowserOpenRequest,
  }
}
