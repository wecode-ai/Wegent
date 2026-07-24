import { createHttpClient } from '@/api/http'

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
