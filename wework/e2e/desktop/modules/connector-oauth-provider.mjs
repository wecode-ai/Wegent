// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Real RFC 9728 / RFC 8414 provider used by the desktop connector checkpoint.
 *
 * The desktop flow must go through discovery, dynamic client registration,
 * PKCE and the browser redirect without stubbing the backend, so this module
 * serves the real provider contract from inside the checkpoint process. Only
 * the model service is faked elsewhere in the harness.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export const CONNECTOR_OAUTH_SLUG = 'desktop-connector-oauth'

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  })
  response.end(body)
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { 'content-length': '0', ...headers })
  response.end()
}

function readBody(request) {
  return new Promise(resolve => {
    let body = ''
    request.on('data', chunk => {
      body += chunk.toString()
    })
    request.on('end', () => resolve(body))
  })
}

/**
 * Start the provider on a random loopback port.
 *
 * The returned handle exposes the counters the checkpoint asserts on and a
 * `close()` for cleanup.
 */
export async function startConnectorOAuthProvider() {
  const state = {
    clients: new Map(),
    codes: new Map(),
    authorizeRequests: 0,
    tokenRequests: 0,
    accessTokens: new Set(),
  }

  const server = createServer(async (request, response) => {
    const base = `http://${request.headers.host}`
    const url = new URL(request.url ?? '/', base)
    const path = url.pathname
    const method = (request.method ?? 'GET').toUpperCase()

    if (path === '/mcp') {
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!state.accessTokens.has(bearer)) {
        // `discover_connector_oauth` reads this header to locate metadata.
        sendEmpty(response, 401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        return
      }
      if (method === 'GET') {
        sendEmpty(response, 405)
        return
      }
      const body = await readBody(request)
      let message = {}
      try {
        message = JSON.parse(body)
      } catch {
        sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700 } })
        return
      }
      const id = message.id ?? null
      if (message.method === 'initialize') {
        sendJson(response, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'desktop-connector-oauth-mcp', version: '1.0.0' },
          },
        })
        return
      }
      if (message.method === 'notifications/initialized') {
        sendEmpty(response, 202)
        return
      }
      sendJson(response, 200, { jsonrpc: '2.0', id, result: { tools: [] } })
      return
    }

    if (path === '/.well-known/oauth-protected-resource/mcp') {
      sendJson(response, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
      })
      return
    }

    if (path === '/.well-known/oauth-authorization-server') {
      sendJson(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }

    if (path === '/register' && method === 'POST') {
      const payload = JSON.parse((await readBody(request)) || '{}')
      const redirectUris = Array.isArray(payload.redirect_uris) ? payload.redirect_uris : []
      if (redirectUris.length === 0) {
        sendJson(response, 400, { error: 'invalid_redirect_uri' })
        return
      }
      const clientId = `desktop-client-${randomBytes(6).toString('hex')}`
      state.clients.set(clientId, { redirectUris })
      sendJson(response, 201, { client_id: clientId, redirect_uris: redirectUris })
      return
    }

    if (path === '/authorize' && method === 'GET') {
      state.authorizeRequests += 1
      const clientId = url.searchParams.get('client_id') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      const client = state.clients.get(clientId)
      if (!client || !client.redirectUris.includes(redirectUri) || !challenge) {
        sendJson(response, 400, { error: 'invalid_request' })
        return
      }
      const code = randomBytes(12).toString('hex')
      state.codes.set(code, { challenge })
      const location = new URL(redirectUri)
      location.searchParams.set('code', code)
      location.searchParams.set('state', url.searchParams.get('state') ?? '')
      sendEmpty(response, 302, { location: location.toString() })
      return
    }

    if (path === '/token' && method === 'POST') {
      state.tokenRequests += 1
      const form = new URLSearchParams(await readBody(request))
      const code = state.codes.get(form.get('code') ?? '')
      const verifier = form.get('code_verifier') ?? ''
      const digest = createHash('sha256').update(verifier).digest('base64url')
      if (!code || code.challenge !== digest) {
        sendJson(response, 400, { error: 'invalid_grant' })
        return
      }
      state.codes.delete(form.get('code') ?? '')
      const access = `desktop-access-${randomBytes(6).toString('hex')}`
      state.accessTokens.add(access)
      sendJson(response, 200, {
        access_token: access,
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'mcp.read',
      })
      return
    }

    sendEmpty(response, 404)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    get authorizeRequests() {
      return state.authorizeRequests
    },
    get tokenRequests() {
      return state.tokenRequests
    },
    close() {
      return new Promise(resolve => server.close(resolve))
    },
  }
}
