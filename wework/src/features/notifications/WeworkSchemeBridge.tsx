import { WEWORK_OPEN_SCHEME_EVENT } from './schemeEvents'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import {
  useWorkspaceTabs,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTabKind } from '@/features/workspace-tabs/workspaceTabs'
import { parseWeworkScheme, weworkDestinationRoute } from './scheme'

function commentTargetRoute(route: string): string {
  const [path, search] = route.split('?')
  const params = new URLSearchParams(search)
  params.delete('commentFocusKey')
  return `${path}${params.size ? `?${params}` : ''}`
}

function navigateWorkspaceTab(
  workspaceTabs: WorkspaceTabsContextValue,
  kind: WorkspaceTabKind,
  contentRoute: string
) {
  const [pathname, search] = contentRoute.split('?')
  const target = parseRuntimeTaskRoute(pathname, search)
  const candidates = workspaceTabs.tabs.filter(tab => tab.kind === kind)
  const matching = candidates.find(tab => {
    if (!target) return commentTargetRoute(tab.contentRoute) === commentTargetRoute(contentRoute)
    const [tabPath, tabSearch] = tab.contentRoute.split('?')
    const task = parseRuntimeTaskRoute(tabPath, tabSearch)
    return task?.deviceId === target.deviceId && task.taskId === target.taskId
  })
  const existing =
    matching ??
    candidates.find(tab => tab.id === workspaceTabs.activeTabId) ??
    candidates.find(tab => tab.fixed) ??
    candidates[0]
  if (existing) workspaceTabs.selectTab(existing.id, { contentRoute })
  else workspaceTabs.openTab(kind, { contentRoute })
}

export function WeworkSchemeBridge() {
  const tabs = useWorkspaceTabs()
  const connection = useContext(CloudConnectionContext)
  const connectionRef = useRef(connection)
  const pendingUrls = useRef(new Set<string>())
  const tabsRef = useRef(tabs)
  useLayoutEffect(() => {
    connectionRef.current = connection
    tabsRef.current = tabs
  }, [connection, tabs])
  const open = useCallback((url: string, deferInRenderer = true): boolean => {
    const destination = parseWeworkScheme(url)
    if (!destination) return true
    const cloud = connectionRef.current
    if (destination.kind === 'board' && (!cloud?.isConnected || !cloud.token)) {
      if (deferInRenderer) pendingUrls.current.add(url)
      if (cloud?.status !== 'restoring' && cloud?.status !== 'connecting') {
        navigateWorkspaceTab(tabsRef.current, 'task', '/settings/connections')
      }
      return false
    }
    navigateWorkspaceTab(
      tabsRef.current,
      destination.kind === 'task' ? 'task' : 'board',
      weworkDestinationRoute(
        destination,
        destination.kind === 'board' && destination.commentId ? crypto.randomUUID() : undefined
      )
    )
    return true
  }, [])

  useEffect(() => {
    if (!connection?.isConnected || !connection.token) return
    const pending = [...pendingUrls.current]
    pendingUrls.current.clear()
    pending.forEach(url => open(url))
  }, [connection?.isConnected, connection?.token, open])

  useEffect(() => {
    const onOpen = (event: Event) => open((event as CustomEvent<string>).detail)
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      const url = target?.getAttribute('href')
      if (!url?.startsWith('wework:')) return
      event.preventDefault()
      event.stopPropagation()
      open(url)
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
            if (open(request.url, false)) {
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
