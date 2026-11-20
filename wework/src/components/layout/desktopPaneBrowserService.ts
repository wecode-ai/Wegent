import {
  closeEmbeddedBrowser,
  listenEmbeddedBrowserPopupRequests,
  migrateEmbeddedBrowserLabelSequence,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import {
  findBrowserTabByPopupParent,
  isDuplicateBrowserPopupRequest,
} from '@/features/browser-tabs/browserPopupRouting'
import { consumeSmartAppDevelopmentPreview } from '@/features/harness-apps/smartAppDevelopmentPreview'
import { stopHarnessAppDevelopmentRuntime } from '@/features/harness-apps/harnessAppDevelopmentRuntime'
import type { WorkbenchPaneWorkspaceState } from './desktopWorkbenchMainHelpers'
import { browserLabelForRightWorkspaceTab } from './desktopWorkbenchMainHelpers'
import type { DesktopPaneWorkspaceState } from './desktopPaneWorkspaceState'
import type { DesktopPaneWorkspaceSession } from './desktopPaneWorkspaceSession'
import type {
  RightWorkspaceBrowserState,
  RightWorkspaceBrowserTab,
} from './workspace-panels/RightWorkspacePanel'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

export interface DesktopPaneBrowserInput {
  paneKey: string
  active: boolean
  workspaceTabId?: string
  sourceBrowserLabel: string
  initialBlankWorkspaceState: WorkbenchPaneWorkspaceState | null
  currentTaskKey: string | null
  pendingBrowserOpenRequest: EmbeddedBrowserOpenRequest | null
  services: WorkbenchServices
  routeBrowserOpenRequest(request: EmbeddedBrowserOpenRequest, assignedToPane?: boolean): void
  openBrowserTab(
    request?: EmbeddedBrowserOpenRequest | null,
    tab?: RightWorkspaceBrowserTab,
    overrides?: Partial<RightWorkspaceBrowserState>
  ): RightWorkspaceBrowserTab
  loadSmartPreview(
    tab: RightWorkspaceBrowserTab,
    installationId: string,
    reload: boolean,
    displayName?: string
  ): Promise<void>
  onBrowserOpenRequestHandled(paneKey: string, requestId: string): void
}
/** Native popup routing, transferred browser labels and development previews share pane ownership. */
export function createDesktopPaneBrowserService(
  state: DesktopPaneWorkspaceState,
  resources: DesktopPaneWorkspaceSession['resources']
) {
  let input: DesktopPaneBrowserInput | null = null
  let popup: ReturnType<typeof listenEmbeddedBrowserPopupRequests> = null
  let popupGeneration = 0
  let migration: AbortController | null = null
  let migrationKey: string | null = null
  let previousActive = false
  let running = false
  function releasePopup() {
    popupGeneration += 1
    const previous = popup
    popup = null
    void previous
      ?.then(unlisten => unlisten())
      .catch(error => console.error('[Wework] Failed to release browser popup routing', error))
  }
  return {
    reconcile(next: DesktopPaneBrowserInput) {
      input = next
      running = true
      if (!popup) {
        const generation = ++popupGeneration
        popup = listenEmbeddedBrowserPopupRequests(request => {
          if (!running || generation !== popupGeneration || !input) return
          const parent = findBrowserTabByPopupParent(
            state.getSnapshot().browserStates,
            request.parentLabel,
            request.parentNativeLabel
          )
          if (
            !parent ||
            isDuplicateBrowserPopupRequest(
              resources.recentBrowserPopupRequestsRef.current,
              parent,
              request.url
            )
          )
            return
          input.routeBrowserOpenRequest({
            id: request.popupId,
            url: request.url,
            baseLabel: input.sourceBrowserLabel,
            source: 'popup',
            disposition: 'new-tab',
            parentLabel: request.parentLabel,
          })
        })
      }
      const transferKey =
        next.initialBlankWorkspaceState && next.currentTaskKey
          ? JSON.stringify([next.currentTaskKey, next.sourceBrowserLabel])
          : null
      if (transferKey !== migrationKey) {
        migration?.abort()
        migration = null
        migrationKey = transferKey
        if (transferKey) {
          const controller = new AbortController()
          migration = controller
          const mappings = Object.entries(
            next.initialBlankWorkspaceState?.browserStates ?? {}
          ).flatMap(([tab, browser]) =>
            browser?.label
              ? [
                  {
                    tab: tab as RightWorkspaceBrowserTab,
                    fromLabel: browser.label,
                    toLabel: browserLabelForRightWorkspaceTab(
                      next.sourceBrowserLabel,
                      tab as RightWorkspaceBrowserTab
                    ),
                    waitForSource: Boolean(browser.nativeLabel || browser.openRequest),
                  },
                ]
              : []
          )
          void migrateEmbeddedBrowserLabelSequence(mappings, {
            signal: controller.signal,
            onMigrated: ({ tab, toLabel }) => {
              if (!running || controller.signal.aborted) return
              state.setBrowserStates(current => {
                const browser = current[tab]
                return !browser || browser.label === toLabel
                  ? current
                  : { ...current, [tab]: { ...browser, label: toLabel } }
              })
            },
          }).catch(error => console.error('Failed to migrate embedded browser label:', error))
        }
      }
      const pending = next.pendingBrowserOpenRequest
      if (pending && resources.routedBrowserOpenRequestIdRef.current !== pending.id) {
        resources.routedBrowserOpenRequestIdRef.current = pending.id
        console.debug('[Wework browser open]', 'openRequestReceived', {
          requestId: pending.id,
          url: pending.url,
          label: pending.label ?? null,
          source: pending.source ?? null,
        })
        next.routeBrowserOpenRequest(pending, true)
      }
      if (
        pending &&
        Object.values(state.getSnapshot().browserStates).some(
          browser => browser?.openRequest?.id === pending.id
        )
      )
        next.onBrowserOpenRequestHandled(next.paneKey, pending.id)
      if (next.active && !previousActive) {
        const preview = consumeSmartAppDevelopmentPreview()
        if (preview) {
          const tab = next.openBrowserTab(null, undefined, {
            label: preview.displayName,
            developmentPreview: {
              installationId: preview.installationId,
              displayName: preview.displayName,
              workspaceTabId: next.workspaceTabId,
              status: 'starting',
              verificationStatus: 'unverified',
            },
          })
          void next.loadSmartPreview(tab, preview.installationId, false, preview.displayName)
        }
      }
      previousActive = next.active
    },
    closeWorkspaceTabs(closedTabIds: ReadonlySet<string>) {
      if (!input) return
      const states = state.getSnapshot().browserStates
      const removed = Object.entries(states).flatMap(([tab, browser]) => {
        const preview = browser?.developmentPreview
        const owner = preview?.workspaceTabId ?? input?.workspaceTabId
        return preview && owner && closedTabIds.has(owner)
          ? [[tab as RightWorkspaceBrowserTab, browser] as const]
          : []
      })
      if (!removed.length) return
      const next = { ...states }
      const installations = new Set<string>()
      for (const [tab, browser] of removed) {
        resources.smartAppDevelopmentPreviewRequestsRef.current.set(
          tab,
          (resources.smartAppDevelopmentPreviewRequestsRef.current.get(tab) ?? 0) + 1
        )
        if (browser.developmentPreview) installations.add(browser.developmentPreview.installationId)
        delete next[tab]
        void closeEmbeddedBrowser(browser.label, browser.nativeLabel ?? undefined).catch(error =>
          console.error('Failed to close Smart app browser with its workspace tab:', error)
        )
      }
      const closedTabs = new Set(removed.map(([tab]) => tab))
      const snapshot = state.getSnapshot()
      const tabs = snapshot.rightPanelTabs.filter(
        tab => !closedTabs.has(tab as RightWorkspaceBrowserTab)
      )
      state.replaceSnapshot({
        ...snapshot,
        browserStates: next,
        rightPanelTabs: tabs,
        rightPanelOpen: tabs.length ? snapshot.rightPanelOpen : false,
        rightPanelExpanded: tabs.length ? snapshot.rightPanelExpanded : false,
        rightPanelView: !tabs.length
          ? 'launcher'
          : closedTabs.has(snapshot.rightPanelView as RightWorkspaceBrowserTab)
            ? tabs[tabs.length - 1]
            : snapshot.rightPanelView,
      })
      for (const id of installations)
        void stopHarnessAppDevelopmentRuntime(
          id,
          input.services.localHarnessModelApi,
          input.services.localDecisionRouterApi
        ).catch(error =>
          console.error('Failed to stop Smart app runtime with its workspace tab:', error)
        )
    },
    suspend() {
      running = false
      previousActive = false
      releasePopup()
      migration?.abort()
      migration = null
      migrationKey = null
    },
    disposePreviews() {
      if (!input) return
      const ids = new Set<string>()
      for (const [tab, browser] of Object.entries(state.getSnapshot().browserStates)) {
        if (!browser?.developmentPreview) continue
        ids.add(browser.developmentPreview.installationId)
        const key = tab as RightWorkspaceBrowserTab
        resources.smartAppDevelopmentPreviewRequestsRef.current.set(
          key,
          (resources.smartAppDevelopmentPreviewRequestsRef.current.get(key) ?? 0) + 1
        )
        void closeEmbeddedBrowser(browser.label, browser.nativeLabel ?? undefined).catch(error =>
          console.error('Failed to close Smart app browser during workbench disposal:', error)
        )
      }
      for (const id of ids)
        void stopHarnessAppDevelopmentRuntime(
          id,
          input.services.localHarnessModelApi,
          input.services.localDecisionRouterApi
        ).catch(error =>
          console.error('Failed to stop Smart app development runtime during disposal:', error)
        )
    },
  }
}
