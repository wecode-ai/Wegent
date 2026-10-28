// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * In-app OAuth consent window for administrator-published connector apps.
 *
 * The workbench used to hand the consent page to the system browser, which
 * took the user out of the app and left the desktop E2E unable to drive the
 * flow. This window keeps consent inside Wework, in a throwaway session so
 * provider cookies never mix with the workbench session, and closes itself once
 * the backend callback page loads — by then the grant is already stored.
 */

import { BrowserWindow, session } from 'electron'

/** Throwaway partition: nothing survives the consent flow. */
export const CONNECTOR_AUTHORIZATION_PARTITION = 'connector-authorization'
/** Backend endpoint that finishes the grant (`connector_apps.py`). */
export const CONNECTOR_AUTHORIZATION_CALLBACK_PATH = '/api/connector-apps/oauth/callback'
/** Let the callback page render its confirmation before closing. */
const CLOSE_DELAY_MS = 400

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

/** Whether a navigation finished the grant on the backend callback. */
export function isConnectorAuthorizationCallback(value: string): boolean {
  try {
    return new URL(value).pathname === CONNECTOR_AUTHORIZATION_CALLBACK_PATH
  } catch {
    return false
  }
}

export interface ConnectorAuthorizationWindowOptions {
  url: string
  parent: BrowserWindow
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

  const closed = new Promise<void>(resolve => window.once('closed', () => resolve()))
  let closing = false
  const closeAfterCallback = (target: string) => {
    if (closing || !isConnectorAuthorizationCallback(target)) return
    closing = true
    setTimeout(() => {
      if (!window.isDestroyed()) window.close()
    }, CLOSE_DELAY_MS)
  }
  window.webContents.on('did-navigate', (_event, target) => closeAfterCallback(target))
  window.webContents.on('will-redirect', (_event, target) => closeAfterCallback(target))

  try {
    await window.loadURL(options.url)
  } catch (error) {
    closing = true
    if (!window.isDestroyed()) window.close()
    await closed
    throw error
  }
  await closed
  await isolated.clearStorageData().catch(() => undefined)
}
