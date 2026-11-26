import { requestDshExecutor } from './dsh/executorTransport'
import type { ConnectionProviderDescriptor } from './standIn'
import { invokeDesktopHost } from './dsh/desktopHost'

export interface WebsiteRequestSample {
  method: 'GET' | 'POST'
  path: string
  query: string[]
  body?: unknown
  response: unknown
  accountPaths?: string[][]
}

export interface WebsiteConnectionCapture {
  origin: string
  pagePath: string
  requests: WebsiteRequestSample[]
}

export function startWebsiteCapture(label: string) {
  return invokeDesktopHost<{ id: string; durationMs: number }>('browser.connectionCapture.start', {
    label,
  })
}

export function finishWebsiteCapture(label: string, id: string) {
  return invokeDesktopHost<WebsiteConnectionCapture>('browser.connectionCapture.finish', {
    label,
    id,
  })
}

export function cancelWebsiteCapture(label: string, id: string) {
  return invokeDesktopHost('browser.connectionCapture.cancel', { label, id })
}

export function resolveWebsiteAccount(
  label: string,
  id: string,
  requestIndex: number,
  path: string[]
) {
  return invokeDesktopHost<{ account: string | number }>('browser.connectionCapture.account', {
    label,
    id,
    requestIndex,
    path,
  })
}

interface WebConnectionTrialPage {
  items: Array<{ id: string; [field: string]: unknown }>
  hasMore: boolean
}

interface WebConnectionTrialEvent {
  objectId: string
  at: string
}

export interface WebConnectionTrial {
  trialId: string
  providerId: string
  page: WebConnectionTrialPage
  continuation?: WebConnectionTrialPage
  collection: { events: WebConnectionTrialEvent[]; hasMore: boolean }
  collectionContinuation?: { events: WebConnectionTrialEvent[] }
  observationWindow: { since: string; until: string }
  threshold?: { field: string; value: number }
}

export function matchWebsiteConnections(url: string) {
  const page = new URL(url)
  return requestDshExecutor<{ items: ConnectionProviderDescriptor[] }>(
    'runtime.connections.catalog',
    { websiteUrl: page.origin + page.pathname }
  )
}

export function testWebsiteConnection(
  label: string,
  captureId: string,
  definition: Record<string, unknown>,
  sample: {
    read: Record<string, unknown>
    observation: { since: string; until: string }
  }
) {
  return requestDshExecutor<WebConnectionTrial>('runtime.connections.web.trial', {
    label,
    captureId,
    definition,
    ...sample,
  })
}

export function installWebsiteConnection(trialId: string) {
  return requestDshExecutor<{ providerId: string }>('runtime.connections.web.install', { trialId })
}
