import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './runtime-environment'

export const WORKSPACE_BROWSER_LABEL = 'wegent-workspace-browser'
export const IN_APP_BROWSER_URL_CHANGED_EVENT = 'in-app-browser-url-changed'
export const IN_APP_BROWSER_TITLE_CHANGED_EVENT = 'in-app-browser-title-changed'
export const IN_APP_BROWSER_FAVICON_CHANGED_EVENT = 'in-app-browser-favicon-changed'

export interface BrowserFrameRect {
  x: number
  y: number
  width: number
  height: number
}

export interface InAppBrowserUrlChangedPayload {
  label: string
  url: string
}

export interface InAppBrowserTitleChangedPayload {
  label: string
  title?: string | null
}

export interface InAppBrowserFaviconChangedPayload {
  faviconUrl?: string | null
  favicon_url?: string | null
  label: string
}

export interface NativeInAppBrowser {
  close: () => Promise<void>
  focus: () => Promise<void>
  hide: () => Promise<void>
  setFrame: (rect: BrowserFrameRect) => Promise<void>
  show: () => Promise<void>
}

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withProtocol)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export async function createNativeInAppBrowser(
  label: string,
  url: string,
  rect: BrowserFrameRect
): Promise<NativeInAppBrowser> {
  const { Webview } = await import('@tauri-apps/api/webview')

  await invoke('in_app_browser_create', { label, url, rect })

  const webview = await Webview.getByLabel(label)
  if (!webview) {
    throw new Error(`In-app browser webview was not created: ${label}`)
  }

  const browser = {
    close: () => webview.close(),
    focus: () => webview.setFocus(),
    hide: () => webview.hide(),
    setFrame: (nextRect: BrowserFrameRect) =>
      invoke<void>('in_app_browser_set_frame', { label, rect: nextRect }),
    show: () => webview.show(),
  }

  return browser
}

export function canUseNativeInAppBrowser(): boolean {
  return isTauriRuntime()
}

export async function closeNativeInAppBrowser(label: string): Promise<void> {
  if (!isTauriRuntime()) return

  const { Webview } = await import('@tauri-apps/api/webview')
  const existing = await Webview.getByLabel(label)
  await existing?.close().catch(() => undefined)
}

export async function hideNativeInAppBrowser(label: string): Promise<void> {
  if (!isTauriRuntime()) return

  const { Webview } = await import('@tauri-apps/api/webview')
  const existing = await Webview.getByLabel(label)
  await existing?.hide().catch(() => undefined)
}

export async function goBackInAppBrowser(label: string): Promise<void> {
  await invoke('in_app_browser_go_back', { label })
}

export async function goForwardInAppBrowser(label: string): Promise<void> {
  await invoke('in_app_browser_go_forward', { label })
}

export async function reloadInAppBrowser(label: string): Promise<void> {
  await invoke('in_app_browser_reload', { label })
}

export async function readInAppBrowserTitle(label: string): Promise<string | null> {
  const title = await Promise.race([
    invoke<string | null>('in_app_browser_page_title', { label }),
    new Promise<null>(resolve => window.setTimeout(() => resolve(null), 800)),
  ])

  return title?.trim() || null
}

export async function readInAppBrowserFavicon(label: string): Promise<string | null> {
  const favicon = await Promise.race([
    invoke<string | null>('in_app_browser_page_favicon', { label }),
    new Promise<null>(resolve => window.setTimeout(() => resolve(null), 800)),
  ])

  return favicon?.trim() || null
}
