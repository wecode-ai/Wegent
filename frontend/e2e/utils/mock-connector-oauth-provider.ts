/**
 * A real RFC 9728 / RFC 8414 authorization server plus the protected MCP
 * resource it issues tokens for.
 *
 * The connector E2E must exercise discovery, dynamic client registration,
 * PKCE, the browser redirect and the stored grant without mocking any of those
 * steps, so the mock model server hosts this provider next to the model
 * endpoints. Only the model service is faked; every OAuth and MCP exchange here
 * is real HTTP.
 */

import type * as http from 'http'
import { createHash, randomBytes } from 'node:crypto'

/** Prefix the provider mounts under on the mock model server. */
export const CONNECTOR_OAUTH_PREFIX = '/connector-oauth'
/** Tool the administrator keeps in `toolAllowlist`. */
export const CONNECTOR_OAUTH_ALLOWED_TOOL = 'echo'
/** Tool the same upstream serves but the allowlist hides. */
export const CONNECTOR_OAUTH_HIDDEN_TOOL = 'delete_everything'
/** Marker the allowed tool echoes so the E2E can prove the call reached it. */
export const CONNECTOR_OAUTH_TOOL_RESULT = 'CONNECTOR-OAUTH-ECHO-OK'

interface RegisteredClient {
  clientId: string
  redirectUris: string[]
}

interface AuthorizationCode {
  clientId: string
  redirectUri: string
  challenge: string
  scope: string
}

interface ProviderState {
  tokenTtlSeconds: number
  rejectRefresh: boolean
  issued: number
  refreshes: number
  authorizationRequests: number
  toolCalls: Array<{ name: string; arguments: unknown }>
  clients: Map<string, RegisteredClient>
  codes: Map<string, AuthorizationCode>
  accessTokens: Set<string>
  refreshTokens: Set<string>
}

const state: ProviderState = {
  tokenTtlSeconds: 3600,
  rejectRefresh: false,
  issued: 0,
  refreshes: 0,
  authorizationRequests: 0,
  toolCalls: [],
  clients: new Map(),
  codes: new Map(),
  accessTokens: new Set(),
  refreshTokens: new Set(),
}

/** Reset the provider between tests so counters start from zero. */
export function resetConnectorOAuthProvider(): void {
  state.tokenTtlSeconds = 3600
  state.rejectRefresh = false
  state.issued = 0
  state.refreshes = 0
  state.authorizationRequests = 0
  state.toolCalls = []
  state.clients.clear()
  state.codes.clear()
  state.accessTokens.clear()
  state.refreshTokens.clear()
}

function bearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return ''
  const [scheme, token] = value.split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' && token ? token : ''
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  })
  res.end(body)
}

function sendEmpty(
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-length': '0', ...headers })
  res.end()
}

function issueTokens(): Record<string, unknown> {
  state.issued += 1
  const access = `connector-access-${state.issued}`
  const refresh = `connector-refresh-${state.issued}`
  state.accessTokens.add(access)
  state.refreshTokens.add(refresh)
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: state.tokenTtlSeconds,
    scope: 'mcp.read',
  }
}

function tokenRequest(res: http.ServerResponse, body: string): void {
  const form = new URLSearchParams(body)
  const grant = form.get('grant_type') ?? ''
  if (grant === 'refresh_token') {
    const refreshToken = form.get('refresh_token') ?? ''
    if (state.rejectRefresh || !state.refreshTokens.has(refreshToken)) {
      state.refreshTokens.delete(refreshToken)
      sendJson(res, 400, { error: 'invalid_grant' })
      return
    }
    state.refreshTokens.delete(refreshToken)
    state.refreshes += 1
    sendJson(res, 200, issueTokens())
    return
  }
  if (grant !== 'authorization_code') {
    sendJson(res, 400, { error: 'unsupported_grant_type' })
    return
  }
  const code = state.codes.get(form.get('code') ?? '')
  if (!code) {
    sendJson(res, 400, { error: 'invalid_grant' })
    return
  }
  if (pkceChallenge(form.get('code_verifier') ?? '') !== code.challenge) {
    sendJson(res, 400, { error: 'invalid_grant' })
    return
  }
  state.codes.delete(form.get('code') ?? '')
  sendJson(res, 200, issueTokens())
}

function authorize(res: http.ServerResponse, url: URL): void {
  state.authorizationRequests += 1
  const clientId = url.searchParams.get('client_id') ?? ''
  const redirectUri = url.searchParams.get('redirect_uri') ?? ''
  const challenge = url.searchParams.get('code_challenge') ?? ''
  const stateToken = url.searchParams.get('state') ?? ''
  const client = state.clients.get(clientId)
  if (!client || !client.redirectUris.includes(redirectUri) || !challenge) {
    sendJson(res, 400, { error: 'invalid_request' })
    return
  }
  const code = randomBytes(18).toString('hex')
  state.codes.set(code, {
    clientId,
    redirectUri,
    challenge,
    scope: url.searchParams.get('scope') ?? '',
  })
  const location = new URL(redirectUri)
  location.searchParams.set('code', code)
  location.searchParams.set('state', stateToken)
  sendEmpty(res, 302, { location: location.toString() })
}

function register(res: http.ServerResponse, body: string): void {
  let payload: { redirect_uris?: string[] } = {}
  try {
    payload = JSON.parse(body) as { redirect_uris?: string[] }
  } catch {
    sendJson(res, 400, { error: 'invalid_client_metadata' })
    return
  }
  const redirectUris = (payload.redirect_uris ?? []).filter(
    uri => typeof uri === 'string' && uri.length > 0
  )
  if (redirectUris.length === 0) {
    sendJson(res, 400, { error: 'invalid_redirect_uri' })
    return
  }
  const clientId = `connector-client-${randomBytes(8).toString('hex')}`
  state.clients.set(clientId, { clientId, redirectUris })
  sendJson(res, 201, {
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
  })
}

const TOOL_DEFINITIONS = [
  {
    name: CONNECTOR_OAUTH_ALLOWED_TOOL,
    description: 'Echo the caller payload back.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  },
  {
    name: CONNECTOR_OAUTH_HIDDEN_TOOL,
    description: 'Administrator disabled this destructive tool.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function mcpCall(res: http.ServerResponse, message: Record<string, unknown>): void {
  const id = message.id ?? null
  const method = String(message.method ?? '')
  const params = (message.params as Record<string, unknown> | undefined) ?? {}
  if (method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-connector-oauth-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized') {
    sendEmpty(res, 202)
    return
  }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } })
    return
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '')
    const args = params.arguments ?? {}
    state.toolCalls.push({ name, arguments: args })
    const result =
      name === CONNECTOR_OAUTH_ALLOWED_TOOL
        ? {
            content: [
              { type: 'text', text: `${CONNECTOR_OAUTH_TOOL_RESULT}:${JSON.stringify(args)}` },
            ],
            structuredContent: { echoed: args, marker: CONNECTOR_OAUTH_TOOL_RESULT },
            isError: false,
          }
        : {
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
            isError: true,
          }
    sendJson(res, 200, { jsonrpc: '2.0', id, result })
    return
  }
  sendJson(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  })
}

function control(res: http.ServerResponse, body: string): void {
  let payload: Record<string, unknown> = {}
  try {
    payload = body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }
  if (typeof payload.tokenTtlSeconds === 'number') {
    state.tokenTtlSeconds = payload.tokenTtlSeconds
  }
  if (typeof payload.rejectRefresh === 'boolean') {
    state.rejectRefresh = payload.rejectRefresh
  }
  if (payload.revokeAll === true) {
    // One-shot: drop every issued token so a later run starts unauthorized.
    state.accessTokens.clear()
    state.refreshTokens.clear()
  }
  sendJson(res, 200, snapshot())
}

function snapshot(): Record<string, unknown> {
  return {
    issued: state.issued,
    refreshes: state.refreshes,
    authorizationRequests: state.authorizationRequests,
    toolCalls: state.toolCalls,
    clients: state.clients.size,
    tokenTtlSeconds: state.tokenTtlSeconds,
    rejectRefresh: state.rejectRefresh,
  }
}

/**
 * Serve one provider request. Returns `true` when the request belonged to the
 * provider so the mock model server stops dispatching it.
 */
export function handleConnectorOAuthRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string
): boolean {
  const host = req.headers.host ?? 'localhost'
  const url = new URL(req.url ?? '/', `http://${host}`)
  const base = `http://${host}${CONNECTOR_OAUTH_PREFIX}`
  const path = url.pathname
  const method = (req.method ?? 'GET').toUpperCase()

  if (path === `/.well-known/oauth-authorization-server${CONNECTOR_OAUTH_PREFIX}`) {
    sendJson(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp.read'],
    })
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/.well-known/oauth-protected-resource`) {
    sendJson(res, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp.read'],
    })
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/register` && method === 'POST') {
    register(res, body)
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/authorize` && method === 'GET') {
    authorize(res, url)
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/token` && method === 'POST') {
    tokenRequest(res, body)
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/_control` && method === 'POST') {
    control(res, body)
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/_state` && method === 'GET') {
    sendJson(res, 200, snapshot())
    return true
  }

  if (path === `${CONNECTOR_OAUTH_PREFIX}/mcp`) {
    const token = bearerToken(req.headers.authorization)
    if (!token || !state.accessTokens.has(token)) {
      // `discover_connector_oauth` reads this header to find the metadata.
      sendEmpty(res, 401, {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      })
      return true
    }
    if (method !== 'POST') {
      sendEmpty(res, 405)
      return true
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(body) as Record<string, unknown>
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })
      return true
    }
    mcpCall(res, message)
    return true
  }

  return false
}
