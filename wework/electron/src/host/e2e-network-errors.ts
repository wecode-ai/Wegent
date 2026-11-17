import type { Session } from 'electron'
import { e2eErrorLog } from './e2e-error-log.js'

interface RequestTiming {
  sentAt: number
  responseAt?: number
}

const sessionRequests = new WeakMap<Session, Map<number, RequestTiming>>()

function finishRequest(target: Session | undefined, id: number) {
  const requests = target ? sessionRequests.get(target) : undefined
  const timing = requests?.get(id)
  requests?.delete(id)
  return {
    sinceSendHeadersMs: timing ? performance.now() - timing.sentAt : null,
    responseHeadersAfterSendMs:
      timing?.responseAt === undefined ? null : timing.responseAt - timing.sentAt,
  }
}

function networkAddress(value: string) {
  const url = new URL(value)
  return { origin: url.origin, path: url.pathname }
}

export function recordE2ENetworkError(
  details: Electron.OnErrorOccurredListenerDetails,
  target?: Session
): void {
  e2eErrorLog.record('network', 'request-failed', 'error', {
    ...networkAddress(details.url),
    requestId: details.id,
    resourceType: details.resourceType,
    method: details.method,
    error: details.error,
    webContentsId: details.webContentsId,
    ...finishRequest(target, details.id),
  })
}

export function installE2ENetworkErrors(target: Session): void {
  if (process.env.VITE_WEWORK_E2E !== 'true') return
  if (sessionRequests.has(target)) return
  const requests = new Map<number, RequestTiming>()
  sessionRequests.set(target, requests)
  e2eErrorLog.record('network', 'started', 'info', {})
  target.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, details => {
    if (!requests.has(details.id)) requests.set(details.id, { sentAt: performance.now() })
  })
  target.webRequest.onResponseStarted({ urls: ['<all_urls>'] }, details => {
    const timing = requests.get(details.id)
    if (timing) timing.responseAt = performance.now()
  })
  target.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, details =>
    recordE2ENetworkError(details, target)
  )
  target.webRequest.onCompleted({ urls: ['<all_urls>'] }, details => {
    const timing = finishRequest(target, details.id)
    if (details.statusCode < 400) return
    e2eErrorLog.record('network', 'http-failed', 'error', {
      ...networkAddress(details.url),
      requestId: details.id,
      resourceType: details.resourceType,
      method: details.method,
      status: details.statusCode,
      webContentsId: details.webContentsId,
      ...timing,
    })
  })
}
