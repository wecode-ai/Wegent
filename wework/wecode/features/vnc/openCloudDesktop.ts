import type { OpenCloudDesktopOptions } from '@/extensions/cloud-desktop-contract'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { getVncConfig } from './api'
import { buildVncPageUrl, prepareVncSession } from './session'

export async function openCloudDesktop({
  connection,
  deviceId,
  isCurrent,
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

  const pageUrl = buildVncPageUrl({ sandboxId: config.sandbox_id, sessionId })
  if (!requestEmbeddedBrowserOpen(pageUrl)) {
    throw new Error('Built-in browser is unavailable')
  }
  return true
}
