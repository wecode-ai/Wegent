import { getRuntimeConfig, joinAppPath } from '@/config/runtime'

interface BuildVncPageUrlOptions {
  deviceId: string
  sandboxId: string
  socketBaseUrl: string
  token: string
}

function buildVncWebSocketBaseUrl(socketBaseUrl: string): string {
  const url = new URL(socketBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function buildVncPageUrl({
  deviceId,
  sandboxId,
  socketBaseUrl,
  token,
}: BuildVncPageUrlOptions): string {
  const { appBasePath } = getRuntimeConfig()
  const vncWsUrl = `${buildVncWebSocketBaseUrl(socketBaseUrl)}/vnc-proxy/${encodeURIComponent(deviceId)}?token=${encodeURIComponent(token)}`
  const pageUrl = new URL(joinAppPath(appBasePath, '/vnc.html'), window.location.origin)

  pageUrl.searchParams.set('wsUrl', vncWsUrl)
  pageUrl.searchParams.set('sandboxId', sandboxId)
  return pageUrl.toString()
}
