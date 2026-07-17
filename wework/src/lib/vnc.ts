import { invoke } from '@tauri-apps/api/core'
import { getRuntimeConfig, joinAppPath } from '@/config/runtime'

interface PrepareVncSessionOptions {
  deviceId: string
  socketBaseUrl: string
  token: string
}

interface BuildVncPageUrlOptions {
  sandboxId: string
  sessionId: string
}

function buildVncWebSocketBaseUrl(socketBaseUrl: string): string {
  const url = new URL(socketBaseUrl)
  switch (url.protocol) {
    case 'http:':
      url.protocol = 'ws:'
      break
    case 'https:':
      url.protocol = 'wss:'
      break
    case 'ws:':
    case 'wss:':
      break
    default:
      throw new Error(`Unsupported VNC socket protocol: ${url.protocol}`)
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export async function prepareVncSession({
  deviceId,
  socketBaseUrl,
  token,
}: PrepareVncSessionOptions): Promise<string> {
  const sessionId = crypto.randomUUID()
  const wsUrl = `${buildVncWebSocketBaseUrl(socketBaseUrl)}/vnc-proxy/${encodeURIComponent(deviceId)}`

  await invoke('prepare_vnc_session', {
    sessionId,
    wsUrl,
    token,
  })
  return sessionId
}

export function buildVncPageUrl({ sandboxId, sessionId }: BuildVncPageUrlOptions): string {
  const { appBasePath } = getRuntimeConfig()
  const pageUrl = new URL(joinAppPath(appBasePath, '/vnc.html'), window.location.href)

  pageUrl.searchParams.set('sessionId', sessionId)
  pageUrl.searchParams.set('sandboxId', sandboxId)
  return pageUrl.toString()
}

export function isInternalVncPageUrl(value: string): boolean {
  try {
    const { appBasePath } = getRuntimeConfig()
    const expectedUrl = new URL(joinAppPath(appBasePath, '/vnc.html'), window.location.href)
    const url = new URL(value)
    return (
      url.protocol === expectedUrl.protocol &&
      url.host === expectedUrl.host &&
      url.pathname === expectedUrl.pathname
    )
  } catch {
    return false
  }
}
