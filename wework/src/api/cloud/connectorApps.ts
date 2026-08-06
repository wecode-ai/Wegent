import { createHttpClient } from '@/api/http'
import type { CloudAuthorizationHandle } from '@/features/cloud-connection/CloudConnectionContext'

export interface WegentConnectorToken {
  access_token: string
  token_type: 'bearer'
  expires_in: number
}

export interface WegentConnectorConnection {
  status: 'disconnected' | 'pending' | 'connected' | 'expired' | 'error'
  external_account_name: string | null
  granted_scopes: string[]
  expires_at: string | null
}

export interface WegentConnectorApp {
  id: number
  slug: string
  name: string
  description: string
  icon_url: string | null
  auth_type: 'none' | 'bearer' | 'oauth2'
  connection: WegentConnectorConnection
}

export interface WegentInstalledConnectorTool {
  name: string
  title: string | null
  description: string
  raw_tool_name: string | null
}

export interface WegentInstalledConnectorApp {
  id: string
  slug: string
  name?: string
  description?: string
  icon_url?: string | null
  runtime_name: string | null
  enabled: boolean
  callable: boolean
  connection: WegentConnectorConnection
  tool_summaries?: WegentInstalledConnectorTool[]
}

export interface WegentInstalledConnectorResponse {
  apps: WegentInstalledConnectorApp[]
}

export interface ConnectorOAuthSession {
  session_id: string
  poll_token: string
  authorize_url: string
  expires_at: number
  poll_interval_seconds: number
}

export interface ConnectorOAuthPollResult {
  status: 'pending' | 'success' | 'declined' | 'failed'
  connection?: WegentConnectorConnection | null
  error?: string | null
}

export const CONNECTOR_AUTHORIZATION_CHANGED_EVENT = 'wegent:connector-authorization-changed'

export function notifyConnectorAuthorizationChanged(): void {
  window.dispatchEvent(new CustomEvent(CONNECTOR_AUTHORIZATION_CHANGED_EVENT))
}

function client(apiBaseUrl: string, token: string) {
  return createHttpClient({
    baseUrl: apiBaseUrl,
    getToken: () => token,
    redirectOnUnauthorized: false,
  })
}

export function issueWegentConnectorToken(
  apiBaseUrl: string,
  token: string
): Promise<WegentConnectorToken> {
  return client(apiBaseUrl, token).post<WegentConnectorToken>('/connector-runtime/token')
}

export function listWegentConnectorApps(
  apiBaseUrl: string,
  token: string
): Promise<WegentConnectorApp[]> {
  return client(apiBaseUrl, token).get<WegentConnectorApp[]>('/connector-apps')
}

export function listWegentInstalledConnectorApps(
  apiBaseUrl: string,
  token: string
): Promise<WegentInstalledConnectorResponse> {
  return client(apiBaseUrl, token).get<WegentInstalledConnectorResponse>('/apps/installed')
}

export function createConnectorOAuthSession(
  apiBaseUrl: string,
  token: string,
  slug: string
): Promise<ConnectorOAuthSession> {
  return client(apiBaseUrl, token).post<ConnectorOAuthSession>(
    `/connector-apps/${encodeURIComponent(slug)}/oauth/sessions`
  )
}

export function pollConnectorOAuthSession(
  apiBaseUrl: string,
  token: string,
  session: ConnectorOAuthSession
): Promise<ConnectorOAuthPollResult> {
  return client(apiBaseUrl, token).get<ConnectorOAuthPollResult>(
    `/connector-apps/oauth/sessions/${encodeURIComponent(
      session.session_id
    )}/poll?poll_token=${encodeURIComponent(session.poll_token)}`,
    { redirectOnUnauthorized: false }
  )
}

export function disconnectWegentConnector(
  apiBaseUrl: string,
  token: string,
  slug: string
): Promise<null> {
  return client(apiBaseUrl, token).delete<null>(
    `/connector-apps/${encodeURIComponent(slug)}/connection`
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export async function authorizeWegentConnector(
  apiBaseUrl: string,
  token: string,
  slug: string,
  openAuthorizationUrl: (url: string) => Promise<CloudAuthorizationHandle | void>
): Promise<WegentConnectorConnection> {
  const session = await createConnectorOAuthSession(apiBaseUrl, token, slug)
  const authorizationHandle = await openAuthorizationUrl(session.authorize_url)
  let windowClosed = false
  void authorizationHandle?.closed?.then(() => {
    windowClosed = true
  })
  const intervalMs = Math.max(500, session.poll_interval_seconds * 1000)
  while (Date.now() < session.expires_at * 1000) {
    await delay(intervalMs)
    const result = await pollConnectorOAuthSession(apiBaseUrl, token, session)
    if (result.status === 'pending') {
      if (windowClosed) throw new Error('GitHub 授权窗口已关闭')
      continue
    }
    if (result.status === 'declined') throw new Error('GitHub 授权已取消')
    if (result.status === 'failed') {
      throw new Error(result.error || 'GitHub 授权失败')
    }
    if (!result.connection) throw new Error('GitHub 授权状态缺失')
    await Promise.resolve(authorizationHandle?.close?.()).catch(() => undefined)
    notifyConnectorAuthorizationChanged()
    return result.connection
  }
  throw new Error('GitHub 授权已超时')
}
