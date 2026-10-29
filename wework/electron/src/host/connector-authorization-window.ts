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

/** The window the renderer may close once the session reaches a terminal state. */
let active: BrowserWindow | null = null

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

/**
 * Close the consent window. The renderer calls this when the polled session
 * reaches `success`, `declined`, or `failed`; a user dismissal closes it the
 * same way, which the poll loop reports as a cancellation.
 */
export function closeConnectorAuthorizationWindow(): void {
  if (active && !active.isDestroyed()) active.close()
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

  active = window
  const closed = new Promise<void>(resolve =>
    window.once('closed', () => {
      if (active === window) active = null
      resolve()
    })
  )

  try {
    await window.loadURL(options.url)
  } catch (error) {
    if (!window.isDestroyed()) window.close()
    await closed
    throw error
  }
  await closed
  await isolated.clearStorageData().catch(() => undefined)
}
