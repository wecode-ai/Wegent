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
import { INTERACTIONS_TAB_ID } from './RuntimeInteractionsContext'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveDshApp } from '@/features/dsh-runtime/dshApps'
import { openHarnessAppTab } from '@/features/harness-apps/harnessAppTabs'

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
  const existing = tabs.tabs.find(tab => tab.contentRoute === contentRoute)
  if (existing) tabs.selectTab(existing.id, { title, contentRoute })
  else tabs.openTab('auxiliary', { title, contentRoute })
}

export function WeworkSchemeBridge() {
  const tabs = useWorkspaceTabs()
  const { t } = useTranslation('common')
  const interactionsTitle = t('interactions.title')
  const pendingTitle = useRef(interactionsTitle)
  const connection = useContext(CloudConnectionContext)
  const connectionRef = useRef(connection)
  const focusRequestRef = useRef(0)
  const pendingUrls = useRef(new Set<string>())
  const tabsRef = useRef(tabs)
  useLayoutEffect(() => {
    connectionRef.current = connection
    tabsRef.current = tabs
    pendingTitle.current = interactionsTitle
  }, [connection, tabs, interactionsTitle])
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
      if (destination.kind === 'interaction') {
        const currentTabs = tabsRef.current
        const contentRoute = weworkDestinationRoute(destination)
        const existing = currentTabs.tabs.find(tab => tab.id === INTERACTIONS_TAB_ID)
        if (existing) currentTabs.selectTab(existing.id, { contentRoute })
        else
          currentTabs.openTab('auxiliary', {
            id: INTERACTIONS_TAB_ID,
            title: pendingTitle.current,
            contentRoute,
          })
        return true
      }
      if (destination.kind === 'app') {
        const app = resolveDshApp(destination.appId)
        if (
          app?.requiresCloud &&
          (!connectionRef.current?.isConnected || !connectionRef.current.token)
        ) {
          return deferForCloud(url, deferInRenderer, connectionRef.current)
        }
        const contentRoute =
          app?.mode === 'native' ? app.path || '/' : `/app/${encodeURIComponent(destination.appId)}`
        const title = app ? t(app.labelKey ?? app.id, app.label) : destination.appId
        openAuxiliaryRoute(tabsRef.current, title, contentRoute)
        return true
      }
      if (destination.kind === 'smart-app') {
        try {
          const installations = await harnessAppsApi.list()
          const installation = installations.find(
            item => item.smartAppId === destination.smartAppId
          )
          if (installation) {
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

  useEffect(() => {
    if (!connection?.isConnected || !connection.token) return
    const pending = [...pendingUrls.current]
    pendingUrls.current.clear()
    pending.forEach(url => void open(url))
  }, [connection?.isConnected, connection?.token, open])

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
            if (await open(request.url, false)) {
              await invokeDesktopHost('navigation.acknowledgeScheme', { id: request.id })
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
    void drain()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [open, connection?.isConnected, connection?.token])
  return null
}
