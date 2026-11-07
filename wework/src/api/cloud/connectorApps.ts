import { beginOperation } from '@/telemetry/operationBus'
import { pluginTelemetryIdentityFromParts } from '@/telemetry/pluginIdentity'
import { observeOperation } from '@/telemetry/observeOperation'
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
  tool_loading_mode: 'static' | 'lazy'
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
  tool_loading_mode?: 'static' | 'lazy'
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

export type ConnectorAuthorizationErrorCode =
  | 'window_closed'
  | 'declined'
  | 'failed'
  | 'timeout'
  | 'connection_missing'

export class ConnectorAuthorizationError extends Error {
  readonly code: ConnectorAuthorizationErrorCode

  constructor(code: ConnectorAuthorizationErrorCode, message?: string) {
    super(message || code)
    this.code = code
    this.name = 'ConnectorAuthorizationError'
  }
}

const CONNECTOR_AUTHORIZATION_ERROR_KEYS: Record<ConnectorAuthorizationErrorCode, string> = {
  window_closed: 'workbench.plugins_connector_auth_window_closed',
  declined: 'workbench.plugins_connector_auth_declined',
  failed: 'workbench.plugins_connector_auth_failed',
  timeout: 'workbench.plugins_connector_auth_timeout',
  connection_missing: 'workbench.plugins_connector_auth_connection_missing',
}

/** Localize an authorization failure without embedding a provider name. */
export function connectorAuthorizationErrorMessage(
  cause: unknown,
  name: string,
  t: (key: string, values?: Record<string, unknown>) => string
): string {
  if (!(cause instanceof ConnectorAuthorizationError)) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  if (cause.code === 'failed' && cause.message !== 'failed') return cause.message
  return t(CONNECTOR_AUTHORIZATION_ERROR_KEYS[cause.code], { name })
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
  return observeOperation('plugin.disconnect', () =>
    client(apiBaseUrl, token).delete<null>(`/connector-apps/${encodeURIComponent(slug)}/connection`)
  )
}

export function refreshWegentConnector(
  apiBaseUrl: string,
  token: string,
  slug: string
): Promise<WegentConnectorConnection> {
  return client(apiBaseUrl, token).post<WegentConnectorConnection>(
    `/connector-apps/${encodeURIComponent(slug)}/connection/refresh`
  )
}

/**
 * Wait until the installed-app catalog exposes the connector's tools.
 *
 * The blocked turn resumes with whatever surface the catalog reports, so
 * resuming before discovery lands would run the continuation without the
 * connector. The wait is bounded: a catalog that never syncs must not trap the
 * user, and the runtime rediscovers on the next call anyway.
 */
export async function waitForConnectorToolCatalog(
  apiBaseUrl: string,
  token: string,
  slug: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  const intervalMs = options.intervalMs ?? 500
  for (;;) {
    try {
      const catalog = await listWegentInstalledConnectorApps(apiBaseUrl, token)
      const app = catalog.apps.find(item => item.slug === slug)
      if (app && (app.tool_summaries?.length ?? 0) > 0) return true
    } catch {
      // A transient catalog read is retried until the deadline.
    }
    if (Date.now() >= deadline) return false
    await delay(intervalMs)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

/** Distinguishes a cancelled attempt from an authorization failure. */
function abortError(): Error {
  const error = new Error('Connector authorization was cancelled')
  error.name = 'AbortError'
  return error
}

export async function authorizeWegentConnector(
  apiBaseUrl: string,
  token: string,
  slug: string,
  openAuthorizationUrl: (url: string) => Promise<CloudAuthorizationHandle | void>,
  options: {
    /**
     * Lifecycle of the attempt that started this authorization. Returning
     * false closes the consent window and aborts with an `AbortError`, so a
     * signed-out or unmounted card cannot keep polling for the old account.
     */
    isCurrent?: () => boolean
  } = {}
): Promise<WegentConnectorConnection> {
  const attempt = beginOperation('plugin.authorize', {
    properties: pluginTelemetryIdentityFromParts({
      marketplace: 'connector',
      pluginKey: slug,
    }),
  })
  let authorizationHandle: CloudAuthorizationHandle | void = undefined
  try {
    const session = await createConnectorOAuthSession(apiBaseUrl, token, slug)
    authorizationHandle = await openAuthorizationUrl(session.authorize_url)
    let windowClosed = false
    void authorizationHandle?.closed?.then(() => {
      windowClosed = true
    })
    const intervalMs = Math.max(500, session.poll_interval_seconds * 1000)
    while (Date.now() < session.expires_at * 1000) {
      await delay(intervalMs)
      if (options.isCurrent && !options.isCurrent()) {
        attempt.cancel()
        throw abortError()
      }
      // The close notification is the fast path; ask the host for the real
      // state too so a late or lost notification still cancels promptly.
      if (!windowClosed && authorizationHandle?.isOpen) {
        const open = await authorizationHandle.isOpen().catch(() => true)
        if (!open) windowClosed = true
      }
      const result = await pollConnectorOAuthSession(apiBaseUrl, token, session)
      if (result.status === 'pending') {
        if (windowClosed) {
          attempt.cancel()
          throw new ConnectorAuthorizationError('window_closed')
        }
        continue
      }
      if (result.status === 'declined') {
        attempt.cancel()
        throw new ConnectorAuthorizationError('declined')
      }
      if (result.status === 'failed') {
        attempt.fail('confirm')
        throw new ConnectorAuthorizationError('failed', result.error || undefined)
      }
      if (!result.connection) {
        attempt.fail('confirm')
        throw new ConnectorAuthorizationError('connection_missing')
      }
      if (result.connection.status === 'connected') attempt.succeed()
      else attempt.fail('confirm')
      notifyConnectorAuthorizationChanged()
      return result.connection
    }
    attempt.fail('confirm')
    throw new ConnectorAuthorizationError('timeout')
  } catch (error) {
    attempt.fail('request')
    throw error
  } finally {
    // Successful, declined, failed, timed out, or the poll itself threw: the
    // consent window belongs to this attempt and must not outlive it.
    await Promise.resolve(authorizationHandle?.close?.()).catch(() => undefined)
  }
}
