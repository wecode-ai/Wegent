import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { getVncConfig } from './api'
import { buildExternalVncPageUrl, buildVncPageUrl, prepareVncSession } from './session'
import type { OpenCloudDesktopOptions } from './types'
import { openSystemBrowserIfCurrent } from './systemBrowser'

export async function openCloudDesktop({
  connection,
  deviceId,
  isCurrent,
  target,
}: OpenCloudDesktopOptions): Promise<boolean> {
  if (!connection.socketBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }

  const config = await getVncConfig(connection, deviceId)
  if (!isCurrent()) return false
  if (!config.sandbox_id) {
    throw new Error('Desktop sandbox ID is missing')
  }

  const sessionId = await prepareVncSession({
    deviceId,
    socketBaseUrl: connection.socketBaseUrl,
    token: connection.token,
  })
  if (!isCurrent()) return false

  if (target === 'system') {
    const pageUrl = await buildExternalVncPageUrl({
      sandboxId: config.sandbox_id,
      sessionId,
    })
    if (!isCurrent()) return false
    const opened = await openSystemBrowserIfCurrent(pageUrl, isCurrent)
    if (!isCurrent()) return false
    if (!opened) throw new Error('VNC external bridge URL is invalid')
    return true
  }

  const pageUrl = buildVncPageUrl({ sandboxId: config.sandbox_id, sessionId })
  if (!requestEmbeddedBrowserOpen(pageUrl)) {
    throw new Error('Built-in browser is unavailable')
  }
  return true
}
