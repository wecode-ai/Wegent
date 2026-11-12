import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import {
  copyDshBrowserAuthentication,
  dshBrowserRequestHeaders,
} from '../runtime/dsh-browser-auth.js'
import type { SmartAppInstallation } from './smart-app-manager.js'
import { protectLightweightWorkbenchFrames } from './lightweight-workbench-navigation.js'
import { workbenchBackgroundThrottling } from './window-background-policy.js'

export interface WorkbenchBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface WorkbenchSurface {
  readonly contents: WebContents
  readonly ready: Promise<void>
  window(): BrowserWindow | null
  showWindow(): void
  showTab(parent: BrowserWindow, bounds: WorkbenchBounds, visible: boolean): void
  hide(): void
  visible(): boolean
  focused(): boolean
  dispose(): void
}

/** One Host-owned page moves between native containers without navigating again. */
export function createWorkbenchSurface(
  installation: SmartAppInstallation,
  onClose: () => void
): WorkbenchSurface {
  if (!installation.webUrl) throw new Error('Workbench runtime is not ready')
  const url = new URL(installation.webUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
    throw new Error('Workbench runtime must use IPv4 loopback HTTP')
  const partition = session.fromPartition(`persist:wework-workbench-${installation.id}`)
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  partition.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: dshBrowserRequestHeaders(details.url, details.requestHeaders) })
  })
  const view = new WebContentsView({
    webPreferences: {
      session: partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: workbenchBackgroundThrottling(process.platform),
    },
  })
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  protectLightweightWorkbenchFrames(view.webContents)
  const blockNavigation = (event: Electron.Event, destination: string) => {
    try {
      if (new URL(destination).origin !== url.origin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  }
  view.webContents.on('will-navigate', blockNavigation)
  view.webContents.on('will-redirect', blockNavigation)
  view.webContents.on('will-attach-webview', event => event.preventDefault())
  let owner: BrowserWindow | null = null
  let window: BrowserWindow | null = null
  let shown = false
  let disposed = false
  const attach = (parent: BrowserWindow) => {
    if (owner === parent) return
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    owner = parent
    parent.contentView.addChildView(view)
  }
  const ready = (async () => {
    await copyDshBrowserAuthentication(session.defaultSession, partition, url.href)
    if (disposed) throw new Error('Workbench opening was canceled')
    await view.webContents.loadURL(url.href)
  })()
  return {
    contents: view.webContents,
    ready,
    window: () => (window && !window.isDestroyed() ? window : null),
    showWindow() {
      if (disposed) throw new Error('Workbench surface is disposed')
      if (!window || window.isDestroyed()) {
        window = new BrowserWindow({
          title: installation.manifest.displayName,
          width: installation.manifest.window?.width ?? 960,
          height: installation.manifest.window?.height ?? 720,
          alwaysOnTop: installation.manifest.window?.alwaysOnTop ?? false,
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.on('close', event => {
          event.preventDefault()
          onClose()
        })
        window.on('resize', () => {
          if (owner !== window || !window || window.isDestroyed()) return
          const [width, height] = window.getContentSize()
          view.setBounds({ x: 0, y: 0, width, height })
        })
      }
      attach(window)
      const [width, height] = window.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height })
      view.setVisible(true)
      shown = true
      window.show()
      window.focus()
      view.webContents.focus()
    },
    showTab(parent, bounds, visible) {
      if (disposed) throw new Error('Workbench surface is disposed')
      if (parent.isDestroyed()) throw new Error('Workbench tab window is unavailable')
      window?.hide()
      attach(parent)
      view.setBounds(bounds)
      view.setVisible(visible)
      shown = visible
    },
    hide() {
      view.setVisible(false)
      window?.hide()
      shown = false
    },
    visible: () => shown && Boolean(owner && !owner.isDestroyed() && owner.isVisible()),
    focused: () =>
      shown &&
      Boolean(owner && !owner.isDestroyed() && owner.isFocused() && view.webContents.isFocused()),
    dispose() {
      disposed = true
      shown = false
      if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
      owner = null
      if (!view.webContents.isDestroyed()) view.webContents.close()
      if (window && !window.isDestroyed()) window.destroy()
      window = null
    },
  }
}

export async function removeWorkbenchSession(id: string): Promise<void> {
  const partition = session.fromPartition(`persist:wework-workbench-${id}`)
  await partition.clearStorageData()
  await partition.clearCache()
}
