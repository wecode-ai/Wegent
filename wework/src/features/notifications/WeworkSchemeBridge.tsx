import { WEWORK_OPEN_SCHEME_EVENT } from './schemeEvents'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { navigateWorkspaceTab } from '@/features/workspace-tabs/workspaceNavigation'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { inferWorkspaceTabKind } from '@/features/workspace-tabs/workspaceTabs'
import { parseWeworkScheme, weworkDestinationRoute } from './scheme'
import { openRuntimeInteractionsTab } from './runtimeInteractionsNavigation'
import { useTranslation } from '@/hooks/useTranslation'
import { getDshApps, resolveDshApp } from '@/features/dsh-runtime/dshApps'
import { subscribeDshSlot, WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { openHarnessAppTab } from '@/features/harness-apps/harnessAppTabs'
import { useAppPreferenceFeatureState } from '@/features/experimental-features/useAppPreferenceFeatureState'
import { isCollaborationExpPath } from '@/features/collaboration-exp/collaborationExpFeature'
import { buildCollaborationExpRoute } from '@/features/collaboration-exp/integration/deepLinks'

function openAuxiliaryRoute(
  tabs: ReturnType<typeof useWorkspaceTabs>,
  title: string,
  contentRoute: string
) {
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

export function WeworkSchemeBridge() {
  const tabs = useWorkspaceTabs()
  const { t } = useTranslation('common')
  const experiment = useAppPreferenceFeatureState('collaborationExperienceEnabled')
  const experimentRef = useRef(experiment)
  const interactionsTitle = t('interactions.title')
  const pendingTitle = useRef(interactionsTitle)
  const connection = useContext(CloudConnectionContext)
  const connectionRef = useRef(connection)
  const focusRequestRef = useRef(0)
  const pendingUrls = useRef(new Set<string>())
  const openedSchemeIds = useRef(new Set<number>())
  const drainSchemesRef = useRef<() => void>(() => {})
  const tabsRef = useRef(tabs)
  useLayoutEffect(() => {
    connectionRef.current = connection
    tabsRef.current = tabs
    pendingTitle.current = interactionsTitle
    experimentRef.current = experiment
  }, [connection, tabs, interactionsTitle, experiment])
  const deferForCloud = useCallback(
    (url: string, deferInRenderer: boolean, cloud: typeof connection) => {
      if (deferInRenderer) pendingUrls.current.add(url)
      if (cloud?.status !== 'restoring' && cloud?.status !== 'connecting') {
        navigateWorkspaceTab(tabsRef.current, 'task', '/settings/connections')
      }
      return false
    },
    []
  )
  const open = useCallback(
    async (url: string, deferInRenderer = true): Promise<boolean> => {
      const destination = parseWeworkScheme(url)
      if (!destination) return true
      if (destination.kind === 'collaboration-exp') {
        if (!experimentRef.current.loaded) {
          if (deferInRenderer) pendingUrls.current.add(url)
          return false
        }
        if (!experimentRef.current.enabled) return true
        const params = new URLSearchParams(destination.contentRoute.split('?')[1])
        if (
          params.get('projectStore') === 'backend' &&
          (!connectionRef.current?.isConnected || !connectionRef.current.token)
        ) {
          return deferForCloud(url, deferInRenderer, connectionRef.current)
        }
        openAuxiliaryRoute(
          tabsRef.current,
          t('workbench.workspace_tab_collaboration_exp'),
          params.has('issueId') || params.has('nodeId')
            ? buildCollaborationExpRoute(params, {
                focusRequest: `${Date.now()}-${++focusRequestRef.current}`,
              })
            : destination.contentRoute
        )
        return true
      }
      if (destination.kind === 'interaction') {
        const currentTabs = tabsRef.current
        const contentRoute = weworkDestinationRoute(destination)
        openRuntimeInteractionsTab(currentTabs, pendingTitle.current, contentRoute)
        return true
      }
      if (destination.kind === 'app') {
        const app = resolveDshApp(destination.appId)
        if (!app) {
          if (getDshApps().length === 0) {
            if (deferInRenderer) pendingUrls.current.add(url)
            return false
          }
          console.warn('[Wework] Rejected an unregistered DSH app deep link')
          return true
        }
        if (
          app.requiresCloud &&
          (!connectionRef.current?.isConnected || !connectionRef.current.token)
        ) {
          return deferForCloud(url, deferInRenderer, connectionRef.current)
        }
        const contentRoute =
          app.mode === 'native' ? app.path || '/' : `/app/${encodeURIComponent(destination.appId)}`
        const title = t(app.labelKey ?? app.id, app.label)
        openAuxiliaryRoute(tabsRef.current, title, contentRoute)
        return true
      }
      if (destination.kind === 'smart-app') {
        try {
          const installations = await harnessAppsApi.list()
          const installation = installations.find(
            item => item.smartAppId === destination.smartAppId
          )
          if (installation?.state === 'running') {
            openHarnessAppTab(tabsRef.current, installation)
            return true
          }
        } catch (error) {
          console.warn('[Wework] Failed to resolve Smart app deep link', error)
        }
        openAuxiliaryRoute(
          tabsRef.current,
          t('workbench.smart_apps_title', '智能工作台'),
          weworkDestinationRoute(destination)
        )
        return true
      }
      const cloud = connectionRef.current
      if (
        destination.kind === 'board' &&
        destination.projectStore !== 'local' &&
        (!cloud?.isConnected || !cloud.token)
      ) {
        return deferForCloud(url, deferInRenderer, cloud)
      }
      const experimentTab =
        destination.kind === 'board' && experimentRef.current.enabled
          ? tabsRef.current.tabs.find(tab => isCollaborationExpPath(tab.contentRoute))
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
          projectView: null,
          assistantDeviceId: null,
          assistantTaskId: null,
          commentId: destination.commentId ?? null,
          focusRequest: destination.itemId ? `${Date.now()}-${++focusRequestRef.current}` : null,
        })
        tabsRef.current.selectTab(experimentTab.id, { contentRoute })
        return true
      }
      navigateWorkspaceTab(
        tabsRef.current,
        destination.kind === 'task' ? 'task' : 'board',
        weworkDestinationRoute(
          destination,
          destination.kind === 'board' && destination.itemId
            ? `${Date.now()}-${++focusRequestRef.current}`
            : undefined
        )
      )
      return true
    },
    [deferForCloud, t]
  )
  const retryPendingSchemes = useCallback(() => {
    const pending = [...pendingUrls.current]
    pendingUrls.current.clear()
    pending.forEach(url => void open(url))
    drainSchemesRef.current()
  }, [open])

  useEffect(() => {
    if (!connection?.isConnected || !connection.token) return
    retryPendingSchemes()
  }, [connection?.isConnected, connection?.token, retryPendingSchemes])

  useEffect(() => {
    if (experiment.loaded) retryPendingSchemes()
  }, [experiment.enabled, experiment.loaded, retryPendingSchemes])

  useEffect(
    () => subscribeDshSlot(WEWORK_DSH_SLOTS.app, retryPendingSchemes),
    [retryPendingSchemes]
  )

  useEffect(() => {
    const onOpen = (event: Event) => void open((event as CustomEvent<string>).detail)
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      const url = target?.getAttribute('href')
      if (!url?.startsWith('wework:')) return
      event.preventDefault()
      event.stopPropagation()
      void open(url)
    }
    window.addEventListener(WEWORK_OPEN_SCHEME_EVENT, onOpen)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener(WEWORK_OPEN_SCHEME_EVENT, onOpen)
      document.removeEventListener('click', onClick, true)
    }
  }, [open])

  useEffect(() => {
    if (!isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    let disposed = false
    let running = false
    let requested = false
    const drain = async () => {
      requested = true
      if (running) return
      running = true
      try {
        while (requested && !disposed) {
          requested = false
          const requests = await invokeDesktopHost<Array<{ id: number; url: string }>>(
            'navigation.pendingSchemes'
          )
          for (const request of requests) {
            if (disposed) break
            if (!openedSchemeIds.current.has(request.id)) {
              if (!(await open(request.url, false))) continue
              openedSchemeIds.current.add(request.id)
            }
            try {
              await invokeDesktopHost('navigation.acknowledgeScheme', { id: request.id })
              openedSchemeIds.current.delete(request.id)
            } catch (error) {
              console.error('[Wework] Failed to acknowledge scheme navigation', error)
            }
          }
        }
      } catch (error) {
        console.error('[Wework] Scheme navigation failed', error)
      } finally {
        running = false
      }
    }
    const unsubscribe = subscribeDesktopHostEvents(event => {
      if (event.type === 'wework-scheme-requested') void drain()
    })
    drainSchemesRef.current = () => void drain()
    void drain()
    return () => {
      disposed = true
      drainSchemesRef.current = () => {}
      unsubscribe()
    }
  }, [open, connection?.isConnected, connection?.token])
  return null
}
