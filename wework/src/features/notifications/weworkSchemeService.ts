import { WEWORK_OPEN_SCHEME_EVENT } from './schemeEvents'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import type { TFunction } from 'i18next'
import { createHttpClient } from '@/api/http'
import { resolveMovedPersonalIssue } from '@wegent/collaboration/platform'
import { createPersonalIssuesApi } from '@/api/personalIssues'
import { createDeliveryApi } from '@/api/deliveries'
import { getRuntimeConfig } from '@/config/runtime'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { navigateWorkspaceTab } from '@/features/workspace-tabs/workspaceNavigation'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { inferWorkspaceTabKind } from '@/features/workspace-tabs/workspaceTabs'
import { parseWeworkScheme, weworkDestinationRoute } from './scheme'
import { openRuntimeInteractionsTab } from './runtimeInteractionsNavigation'
import { getDshApps, resolveDshApp } from '@/features/dsh-runtime/dshApps'
import { subscribeDshSlot, WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { openHarnessAppTab } from '@/features/harness-apps/harnessAppTabs'
import type { AppPreferenceFeatureState } from '@/features/experimental-features/useAppPreferenceFeatureState'
import { isCollaborationExpPath } from '@/features/collaboration-exp/collaborationExpFeature'
import {
  buildCollaborationExpRoute,
  canonicalAssistantRoute,
} from '@/features/collaboration-exp/integration/deepLinks'

function openAuxiliaryRoute(tabs: WorkspaceTabsContextValue, title: string, contentRoute: string) {
  const pathname = new URL(contentRoute, 'https://wework.invalid').pathname
  if (inferWorkspaceTabKind(pathname) !== 'auxiliary') {
    navigateWorkspaceTab(tabs, inferWorkspaceTabKind(pathname), contentRoute)
    return
  }
  const existing = tabs.tabs.find(tab =>
    isCollaborationExpPath(contentRoute)
      ? isCollaborationExpPath(tab.contentRoute)
      : tab.contentRoute === contentRoute
  )
  if (existing) tabs.selectTab(existing.id, { title, contentRoute })
  else tabs.openTab('auxiliary', { title, contentRoute })
}

export interface WeworkSchemeInput {
  tabs: WorkspaceTabsContextValue
  connection: CloudConnectionContextValue | null
  experiment: AppPreferenceFeatureState
  t: TFunction<'common'>
}

/** Route-owned native navigation handles committed commands without React lifecycle mirrors. */
export function createWeworkSchemeService() {
  let input: WeworkSchemeInput | null = null
  let generation = 0
  let navigationOrder = 0
  let focusRequest = 0
  const pendingUrls = new Set<string>()
  const openedSchemeIds = new Set<number>()
  let dispose: (() => void) | undefined
  let running = false
  let requested = false
  let previousCloud = ''
  let previousExperiment = ''
  const deferForCloud = (
    url: string,
    deferInRenderer: boolean,
    cloud: CloudConnectionContextValue | null
  ) => {
    if (deferInRenderer) pendingUrls.add(url)
    if (input && cloud?.status !== 'restoring' && cloud?.status !== 'connecting')
      navigateWorkspaceTab(input.tabs, 'task', '/settings/connections')
    return false
  }
  async function open(url: string, deferInRenderer = true): Promise<boolean> {
    if (!input) return false
    const revision = generation
    let destination = parseWeworkScheme(url)
    if (!destination) return true
    const order = ++navigationOrder
    if (destination.kind === 'collaboration-exp') {
      const assistantRoute = canonicalAssistantRoute(destination.contentRoute)
      if (assistantRoute !== destination.contentRoute) {
        navigateWorkspaceTab(input.tabs, 'task', assistantRoute)
        return true
      }
      if (!input.experiment.loaded) {
        if (deferInRenderer) pendingUrls.add(url)
        return false
      }
      if (!input.experiment.enabled) return true
      const params = new URLSearchParams(destination.contentRoute.split('?')[1])
      if (
        params.get('projectStore') === 'backend' &&
        (!input.connection?.isConnected || !input.connection.token)
      ) {
        return deferForCloud(url, deferInRenderer, input.connection)
      }
      openAuxiliaryRoute(
        input.tabs,
        input.t('workbench.workspace_tab_collaboration_exp'),
        params.has('issueId') || params.has('nodeId')
          ? buildCollaborationExpRoute(params, {
              focusRequest: `${Date.now()}-${++focusRequest}`,
            })
          : destination.contentRoute
      )
      return true
    }
    if (destination.kind === 'interaction') {
      const currentTabs = input.tabs
      const contentRoute = weworkDestinationRoute(destination)
      openRuntimeInteractionsTab(currentTabs, input.t('interactions.title'), contentRoute)
      return true
    }
    if (destination.kind === 'app') {
      const app = resolveDshApp(destination.appId)
      if (!app) {
        if (getDshApps().length === 0) {
          if (deferInRenderer) pendingUrls.add(url)
          return false
        }
        console.warn('[Wework] Rejected an unregistered DSH app deep link')
        return true
      }
      if (app.requiresCloud && (!input.connection?.isConnected || !input.connection.token)) {
        return deferForCloud(url, deferInRenderer, input.connection)
      }
      const contentRoute =
        app.mode === 'native' ? app.path || '/' : `/app/${encodeURIComponent(destination.appId)}`
      const title = input.t(app.labelKey ?? app.id, app.label)
      openAuxiliaryRoute(input.tabs, title, contentRoute)
      return true
    }
    if (destination.kind === 'smart-app') {
      const { smartAppId } = destination
      try {
        const installations = await harnessAppsApi.list()
        if (!input || revision !== generation) return false
        const installation = installations.find(item => item.smartAppId === smartAppId)
        if (installation?.state === 'running') {
          openHarnessAppTab(input.tabs, installation)
          return true
        }
      } catch (error) {
        console.warn('[Wework] Failed to resolve Smart app deep link', error)
      }
      if (!input || revision !== generation) return false
      openAuxiliaryRoute(
        input.tabs,
        input.t('workbench.smart_apps_title', '智能工作台'),
        weworkDestinationRoute(destination)
      )
      return true
    }
    const cloud = input.connection
    if (
      (destination.kind === 'personal-issue' ||
        (destination.kind === 'board' && destination.projectStore !== 'local')) &&
      (!cloud?.isConnected || !cloud.token)
    ) {
      return deferForCloud(url, deferInRenderer, cloud)
    }
    if (destination.kind === 'personal-issue' && cloud) {
      const client = createHttpClient({
        baseUrl: cloud.apiBaseUrl ?? getRuntimeConfig().apiBaseUrl,
        getToken: () => cloud.token,
        redirectOnUnauthorized: false,
      })
      const issueId = destination.issueId
      const movedProjectId = await createPersonalIssuesApi(client)
        .get(issueId)
        .then(
          () => null,
          reason =>
            resolveMovedPersonalIssue(reason, () => createDeliveryApi(client).getLoopItem(issueId))
        )
      if (
        !input ||
        revision !== generation ||
        cloud.user?.id !== input.connection?.user?.id ||
        cloud.apiBaseUrl !== input.connection?.apiBaseUrl
      )
        return false
      // A superseded native request is consumed so it cannot replay on the next drain.
      if (order !== navigationOrder) return true
      if (movedProjectId) {
        destination = {
          kind: 'board',
          projectId: movedProjectId,
          itemId: issueId,
        }
      }
    }
    const experimentTab =
      destination.kind === 'board' && input.experiment.enabled
        ? input.tabs.tabs.find(tab => isCollaborationExpPath(tab.contentRoute))
        : undefined
    if (destination.kind === 'board' && experimentTab) {
      const contentRoute = buildCollaborationExpRoute(experimentTab.contentRoute.split('?')[1], {
        view: 'tasks',
        projectStore: destination.projectStore ?? 'backend',
        projectId: destination.projectId,
        issueId: destination.itemId ?? null,
        nodeId: null,
        discussion: null,
        inspector: null,
        timelineFilter: null,
        projectView: destination.itemId ? null : 'overview',
        ...(destination.itemId ? {} : { taskMode: 'projects' }),
        assistantDeviceId: null,
        assistantTaskId: null,
        commentId: destination.commentId ?? null,
        focusRequest: destination.itemId ? `${Date.now()}-${++focusRequest}` : null,
      })
      input.tabs.selectTab(experimentTab.id, { contentRoute })
      return true
    }
    navigateWorkspaceTab(
      input.tabs,
      destination.kind === 'task' ? 'task' : 'board',
      weworkDestinationRoute(
        destination,
        destination.kind === 'personal-issue' ||
          (destination.kind === 'board' && destination.itemId)
          ? `${Date.now()}-${++focusRequest}`
          : undefined
      )
    )
    return true
  }
  async function drain() {
    if (!input || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    requested = true
    if (running) return
    running = true
    const revision = generation
    try {
      while (requested && input && revision === generation) {
        requested = false
        const requests = await invokeDesktopHost<Array<{ id: number; url: string }>>(
          'navigation.pendingSchemes'
        )
        for (const request of requests) {
          if (!input || revision !== generation) break
          if (!openedSchemeIds.has(request.id)) {
            if (!(await open(request.url, false))) continue
            if (!input || revision !== generation) break
            openedSchemeIds.add(request.id)
          }
          try {
            await invokeDesktopHost('navigation.acknowledgeScheme', { id: request.id })
            if (revision === generation) openedSchemeIds.delete(request.id)
          } catch (error) {
            console.error('[Wework] Failed to acknowledge scheme navigation', error)
          }
        }
      }
    } catch (error) {
      console.error('[Wework] Scheme navigation failed', error)
    } finally {
      running = false
      if (requested && input && revision !== generation) void drain()
    }
  }
  function retryPendingSchemes() {
    const pending = [...pendingUrls]
    pendingUrls.clear()
    pending.forEach(url => void open(url))
    void drain()
  }
  return {
    observe(next: WeworkSchemeInput) {
      input = next
      const starting = !dispose
      if (!dispose) {
        const custom = (event: Event) => void open((event as CustomEvent<string>).detail)
        const click = (event: MouseEvent) => {
          const target = event.target instanceof Element ? event.target.closest('a[href]') : null
          const url = target?.getAttribute('href')
          if (!url?.startsWith('wework:')) return
          event.preventDefault()
          event.stopPropagation()
          void open(url)
        }
        window.addEventListener(WEWORK_OPEN_SCHEME_EVENT, custom)
        document.addEventListener('click', click, true)
        const stopSlots = subscribeDshSlot(WEWORK_DSH_SLOTS.app, retryPendingSchemes)
        const stopHost =
          isElectronRuntime() && getDesktopWindowLabel() === 'main'
            ? subscribeDesktopHostEvents(event => {
                if (event.type === 'wework-scheme-requested') void drain()
              })
            : undefined
        dispose = () => {
          window.removeEventListener(WEWORK_OPEN_SCHEME_EVENT, custom)
          document.removeEventListener('click', click, true)
          stopSlots()
          stopHost?.()
        }
      }
      const cloud = JSON.stringify([next.connection?.isConnected, next.connection?.token])
      const experiment = JSON.stringify([next.experiment.loaded, next.experiment.enabled])
      if (
        (cloud !== previousCloud && next.connection?.isConnected && next.connection.token) ||
        (experiment !== previousExperiment && next.experiment.loaded)
      )
        retryPendingSchemes()
      else if (starting) void drain()
      previousCloud = cloud
      previousExperiment = experiment
    },
    suspend() {
      input = null
    },
    disconnect() {
      input = null
      generation += 1
      requested = false
      dispose?.()
      dispose = undefined
      previousCloud = ''
      previousExperiment = ''
    },
  }
}
