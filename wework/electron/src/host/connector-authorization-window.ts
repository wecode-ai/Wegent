// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * In-app OAuth consent window for administrator-published connector apps.
 *
 * The workbench used to hand the consent page to the system browser, which
 * took the user out of the app and left the desktop E2E unable to drive the
 * flow. This window keeps consent inside Wework, in a throwaway session so
 * provider cookies never mix with the workbench session.
 *
 * The window closes when the renderer reports the session's terminal state.
 * Closing it on the callback navigation would race the backend's code
 * exchange: a slow provider makes the next poll still see `pending`, and the
 * user gets "window closed" even though the grant is about to land.
 */

import { BrowserWindow, session } from 'electron'

/** Throwaway partition: nothing survives the consent flow. */
export const CONNECTOR_AUTHORIZATION_PARTITION = 'connector-authorization'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * The consent page may live on any https origin, but a plaintext origin is
 * only acceptable for a local provider.
 */
export function isConnectorAuthorizationUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

interface TrackedWindow {
  window: BrowserWindow
  closed: Promise<void>
}

/**
 * Windows currently open, keyed by the renderer's request id. A poll loop owns
 * exactly one id, so closing an attempt can never close another one.
 */
const tracked = new Map<string, TrackedWindow>()

/**
 * Close the consent window for one attempt. Closing a window that already
 * closed (or never opened) is a no-op, so every exit path can call it.
 */
export function closeConnectorAuthorizationWindow(requestId: string): void {
  const entry = tracked.get(requestId)
  if (!entry) return
  tracked.delete(requestId)
  if (!entry.window.isDestroyed()) entry.window.close()
}

/**
 * Whether the attempt's consent window is still open.
 *
 * The renderer learns about a close through the durable host event stream
 * instead of holding one long-lived request: an authorization can stay open
 * far longer than any single host request may, and a timed-out request would
 * silently drop the close it was waiting for.
 */
export function isConnectorAuthorizationWindowOpen(requestId: string): boolean {
  return tracked.has(requestId)
}

export interface ConnectorAuthorizationWindowOptions {
  url: string
  parent: BrowserWindow
  /** The renderer's id for this authorization attempt. */
  requestId: string
  /** Notified once, whether the user dismissed the window or the flow ended. */
  onClosed?: (requestId: string) => void
}

/**
 * Open the consent page and resolve once the window closes, whether the user
 * dismissed it or the callback completed.
 */
export async function openConnectorAuthorizationWindow(
  options: ConnectorAuthorizationWindowOptions
): Promise<void> {
  const isolated = session.fromPartition(CONNECTOR_AUTHORIZATION_PARTITION, { cache: false })
  const window = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Authorization',
    parent: options.parent,
    modal: true,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: isolated,
    },
  })
  window.setMenuBarVisibility(false)
  // The consent page navigates itself; popups would escape the isolated flow.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve
  })
  let notified = false
  const notifyClosed = () => {
    if (notified) return
    notified = true
    options.onClosed?.(options.requestId)
  }
  window.once('closed', () => {
    if (tracked.get(options.requestId)?.window === window) {
      tracked.delete(options.requestId)
    }
    void isolated.clearStorageData().catch(() => undefined)
    resolveClosed()
    notifyClosed()
  })
  tracked.set(options.requestId, { window, closed })

  try {
    await window.loadURL(options.url)
  } catch (error) {
    closeConnectorAuthorizationWindow(options.requestId)
    await closed
    notifyClosed()
    throw error
  }
}
