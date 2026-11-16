import type { Session } from 'electron'
import { e2eErrorLog } from './e2e-error-log.js'

const registeredSessions = new WeakSet<Session>()

export function recordE2ENetworkError(details: Electron.OnErrorOccurredListenerDetails): void {
  e2eErrorLog.record('network', 'request-failed', 'error', {
    path: new URL(details.url).pathname,
    method: details.method,
    error: details.error,
    webContentsId: details.webContentsId,
  })
}

export function installE2ENetworkErrors(target: Session): void {
  if (process.env.VITE_WEWORK_E2E !== 'true') return
  if (registeredSessions.has(target)) return
  registeredSessions.add(target)
  e2eErrorLog.record('network', 'started', 'info', {})
  target.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, recordE2ENetworkError)
  target.webRequest.onCompleted({ urls: ['<all_urls>'] }, details => {
    if (details.statusCode < 400) return
    e2eErrorLog.record('network', 'http-failed', 'error', {
      path: new URL(details.url).pathname,
      method: details.method,
      status: details.statusCode,
      webContentsId: details.webContentsId,
    })
  })
}
