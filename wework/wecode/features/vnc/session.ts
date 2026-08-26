import { invokeDesktopHost } from '@/api/dsh/desktopHost'

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

  await invokeDesktopHost('vnc.prepareSession', {
    sessionId,
    wsUrl,
    token,
  })
  return sessionId
}

export async function buildVncPageUrl({
  sandboxId,
  sessionId,
}: BuildVncPageUrlOptions): Promise<string> {
  const bridgeUrl = new URL(await invokeDesktopHost<string>('vnc.externalBridgeUrl'))
  if (
    bridgeUrl.protocol !== 'http:' ||
    bridgeUrl.hostname !== '127.0.0.1' ||
    !bridgeUrl.port ||
    bridgeUrl.username ||
    bridgeUrl.password
  ) {
    throw new Error('Invalid VNC external bridge URL')
  }

  const pageUrl = new URL('/vnc.html', bridgeUrl)
  pageUrl.searchParams.set('sessionId', sessionId)
  pageUrl.searchParams.set('sandboxId', sandboxId)
  return pageUrl.toString()
}

export function isInternalVncPageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Boolean(url.port) &&
      !url.username &&
      !url.password &&
      url.pathname === '/vnc.html' &&
      Boolean(url.searchParams.get('sessionId')) &&
      Boolean(url.searchParams.get('sandboxId')) &&
      !url.hash
    )
  } catch {
    return false
  }
}
