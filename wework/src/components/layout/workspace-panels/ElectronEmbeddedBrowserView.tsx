import { useLayoutEffect, useRef } from 'react'

interface BrowserVisualRect {
  x: number
  y: number
  width: number
  height: number
}

interface ElectronEmbeddedBrowserViewProps {
  active: boolean
  interactionBlocked: boolean
  label: string
  visualRect: BrowserVisualRect | null
}

interface ElectronWebviewElement extends HTMLElement {
  destroy?: () => void
}

const WEBVIEW_HOST_ROOT_ATTRIBUTE = 'data-wework-browser-webview-host-root'
const ROUTE_PARTITION_PREFIX = 'persist:wework-browser-app-route:'
const ROUTE_HOST_SEPARATOR = ':host:'
const rendererInstanceId = getRendererInstanceId()
let nextHostGeneration = 0

function getRendererInstanceId() {
  const storageKey = 'wework.browser.renderer-instance-id'
  const stored = window.sessionStorage.getItem(storageKey)
  if (stored) return stored
  const id =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  window.sessionStorage.setItem(storageKey, id)
  return id
}

function getWebviewHostRoot() {
  const existing = document.querySelector<HTMLElement>(`[${WEBVIEW_HOST_ROOT_ATTRIBUTE}]`)
  if (existing) return existing
  const root = document.createElement('div')
  root.setAttribute(WEBVIEW_HOST_ROOT_ATTRIBUTE, '')
  Object.assign(root.style, {
    inset: '0',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    zIndex: '10',
  })
  document.body.append(root)
  return root
}

function routePartition(label: string, hostGeneration: number) {
  const route = `${ROUTE_PARTITION_PREFIX}${encodeURIComponent(`wework\0${label}`)}`
  return `${route}${ROUTE_HOST_SEPARATOR}${rendererInstanceId}:${hostGeneration}`
}

export function ElectronEmbeddedBrowserView({
  active,
  interactionBlocked,
  label,
  visualRect,
}: ElectronEmbeddedBrowserViewProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const initialLabelRef = useRef(label)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const placeholder = placeholderRef.current
    if (!placeholder) return
    const container = document.createElement('div')
    const webview = document.createElement('webview') as ElectronWebviewElement
    const hostGeneration = ++nextHostGeneration
    container.dataset.testid = 'workspace-browser-electron-webview'
    container.dataset.weworkBrowserWebview = initialLabelRef.current
    webview.setAttribute('data-wework-browser-label', initialLabelRef.current)
    webview.setAttribute('data-browser-sidebar-conversation-id', 'wework')
    webview.setAttribute('data-browser-sidebar-browser-tab-id', initialLabelRef.current)
    webview.setAttribute('partition', routePartition(initialLabelRef.current, hostGeneration))
    webview.setAttribute('src', 'about:blank')
    webview.setAttribute('webviewrole', 'tab')
    webview.setAttribute('aria-label', 'Wework built-in browser content')
    Object.assign(webview.style, {
      display: 'flex',
      height: '100%',
      width: '100%',
    })
    Object.assign(container.style, {
      overflow: 'hidden',
      position: 'fixed',
    })
    container.append(webview)
    getWebviewHostRoot().append(container)
    containerRef.current = container

    const syncBounds = () => {
      const rect = placeholder.getBoundingClientRect()
      Object.assign(container.style, {
        height: `${Math.max(0, rect.height)}px`,
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${Math.max(0, rect.width)}px`,
      })
    }
    syncBounds()
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(syncBounds) : null
    resizeObserver?.observe(placeholder)
    window.addEventListener('resize', syncBounds)
    window.addEventListener('scroll', syncBounds, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('scroll', syncBounds, true)
      containerRef.current = null
      if (typeof webview.destroy === 'function') webview.destroy()
      else webview.remove()
      container.remove()
    }
  }, [])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.style.pointerEvents = interactionBlocked ? 'none' : 'auto'
    container.style.visibility = active ? 'visible' : 'hidden'
  }, [active, interactionBlocked])

  return (
    <div
      ref={placeholderRef}
      data-testid="workspace-browser-electron-webview-placeholder"
      className="pointer-events-none absolute overflow-hidden bg-background"
      style={{
        left: visualRect?.x ?? 0,
        top: visualRect?.y ?? 0,
        width: visualRect?.width ?? '100%',
        height: visualRect?.height ?? '100%',
      }}
    />
  )
}
