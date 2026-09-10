// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Catch-all API Proxy Route
 *
 * This route proxies all /api/* requests to the backend server.
 * Unlike next.config.js rewrites, this reads RUNTIME_INTERNAL_API_URL
 * at runtime, allowing the backend URL to be configured via environment
 * variables when the container starts.
 *
 * This replaces the rewrites() in next.config.js for runtime flexibility.
 *
 * Security:
 * - Only allows same-origin requests from frontend pages
 * - Returns 404 for direct browser URL access to /api/* endpoints
 * - Whitelisted paths (OIDC callbacks, webhooks) bypass same-origin check
 */

import { NextRequest, NextResponse } from 'next/server'
import { getInternalApiUrl } from '@/lib/server-config'

/**
 * Paths that bypass same-origin check and allow external access.
 * These are typically OAuth/OIDC callbacks from external identity providers,
 * or webhooks triggered by external systems.
 */
const ALLOWED_EXTERNAL_PATHS = [
  '/api/auth/oidc/callback', // OIDC callback from identity provider
  '/api/auth/oidc/cli-callback', // CLI OIDC callback
  '/api/auth/oauth/callback', // OAuth callback
  '/api/flows/webhook/', // Flow webhook triggers from external systems
  '/api/attachments/download/shared', // Signed attachment downloads for model providers
]

const SKILL_DOWNLOAD_PATH = /^\/api\/v1\/kinds\/skills\/(?:public\/)?(\d+)\/download$/
let skillDownloadInflight = 0

type SkillDownloadObservation = {
  skillId: string
  skillName: string
  requestId: string
  startedAt: number
  inflight: number
}

function beginSkillDownloadObservation(
  targetPath: string,
  headers: Headers
): SkillDownloadObservation | null {
  const match = SKILL_DOWNLOAD_PATH.exec(targetPath)
  if (!match) {
    return null
  }

  const requestId = headers.get('X-Request-ID') || `skill-download-${crypto.randomUUID()}`
  headers.set('X-Request-ID', requestId)
  skillDownloadInflight += 1

  return {
    skillId: match[1],
    skillName: decodeHeaderValue(headers.get('X-Wegent-Skill-Name')) || 'unknown',
    requestId,
    startedAt: performance.now(),
    inflight: skillDownloadInflight,
  }
}

function finishSkillDownloadObservation(): void {
  skillDownloadInflight = Math.max(0, skillDownloadInflight - 1)
}

function decodeHeaderValue(value: string | null): string {
  if (!value) {
    return ''
  }
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

function nonNegativeHeaderNumber(value: string | null): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function skillDownloadResult(status: number): string {
  if (status === 304) {
    return 'not_modified'
  }
  return status >= 200 && status < 300 ? 'success' : 'http_error'
}

function logSkillDownloadObservation(
  observation: SkillDownloadObservation,
  response?: Response
): number {
  const upstreamTimeMs = Math.max(0, performance.now() - observation.startedAt)
  const upstreamStatus = response?.status ?? 'unavailable'
  const responseSkillName = decodeHeaderValue(response?.headers.get('X-Wegent-Skill-Name') ?? null)
  const result = response ? skillDownloadResult(response.status) : 'gateway_error'
  const cacheSource =
    response && response.status < 400
      ? response.headers.get('X-Wegent-Skill-Cache-Source') || 'backend'
      : 'none'
  const bytes = response
    ? nonNegativeHeaderNumber(
        response.headers.get('X-Wegent-Skill-Bytes') || response.headers.get('Content-Length')
      )
    : 0

  console.info(
    '[Skill Download]',
    JSON.stringify({
      component: 'gateway',
      skill_id: observation.skillId,
      skill_name: responseSkillName || observation.skillName,
      cache_source: cacheSource,
      bytes,
      duration_ms: Number(upstreamTimeMs.toFixed(2)),
      result,
      inflight: observation.inflight,
      upstream_time_ms: Number(upstreamTimeMs.toFixed(2)),
      upstream_status: upstreamStatus,
      backend_time_ms: response
        ? nonNegativeHeaderNumber(response.headers.get('X-Wegent-Backend-Time-Ms'))
        : 0,
      request_id: response?.headers.get('X-Request-ID') || observation.requestId,
    })
  )

  return upstreamTimeMs
}

/**
 * Check if the request path is in the allowed external paths list
 */
function isAllowedExternalPath(pathname: string): boolean {
  return ALLOWED_EXTERNAL_PATHS.some(allowedPath => pathname.startsWith(allowedPath))
}

/**
 * Check if the request is a same-origin request from the frontend application.
 * Returns true for fetch() from frontend pages, false for direct browser URL access.
 *
 * Detection methods:
 * 1. sec-fetch-site header (should be 'same-origin' for modern browsers)
 * 2. Referer header (should be from the same host)
 * 3. X-Wegent-Internal header (custom header for special cases)
 */
function isSameOriginRequest(request: NextRequest): boolean {
  // Check sec-fetch-site header (modern browsers)
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite === 'same-origin') {
    return true
  }

  // Check Referer header
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      const refererUrl = new URL(referer)
      const requestHost = request.headers.get('host') || ''
      // Check if referer is from the same host
      if (refererUrl.host === requestHost) {
        return true
      }
    } catch {
      // Invalid referer URL
    }
  }

  return false
}

function decodeAuthToken(rawToken: string): string {
  if (!rawToken) {
    return ''
  }

  try {
    return decodeURIComponent(rawToken)
  } catch {
    return rawToken
  }
}

/**
 * Proxy handler for all HTTP methods
 */
async function proxyRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await params
  const targetPath = `/api/${path.join('/')}`

  // Security: Only allow same-origin requests or whitelisted paths
  // Non-same-origin requests to non-whitelisted paths return 404
  if (!isSameOriginRequest(request) && !isAllowedExternalPath(targetPath)) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const backendUrl = getInternalApiUrl()
  const targetUrl = new URL(targetPath, backendUrl)

  // Preserve query parameters
  const searchParams = request.nextUrl.searchParams
  searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value)
  })

  let skillDownloadObservation: SkillDownloadObservation | null = null
  try {
    // Forward headers, excluding host-related ones
    const headers = new Headers()
    request.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase()
      if (
        lowerKey !== 'host' &&
        lowerKey !== 'connection' &&
        lowerKey !== 'keep-alive' &&
        lowerKey !== 'transfer-encoding'
      ) {
        headers.set(key, value)
      }
    })

    if (!headers.has('Authorization')) {
      const cookieToken = request.cookies.get('auth_token')?.value
      const decodedToken = decodeAuthToken(cookieToken || '')
      if (decodedToken) {
        headers.set('Authorization', `Bearer ${decodedToken}`)
      }
    }

    skillDownloadObservation = beginSkillDownloadObservation(targetPath, headers)

    // Get request body for methods that support it
    let body: BodyInit | null = null
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer()
    }

    // Forward the request to backend
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      // Don't follow redirects, let the client handle them
      redirect: 'manual',
    })
    const gatewayUpstreamTimeMs = skillDownloadObservation
      ? logSkillDownloadObservation(skillDownloadObservation, response)
      : null

    // Create response headers, excluding hop-by-hop headers
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase()
      if (
        lowerKey !== 'transfer-encoding' &&
        lowerKey !== 'connection' &&
        lowerKey !== 'keep-alive'
      ) {
        responseHeaders.set(key, value)
      }
    })
    if (gatewayUpstreamTimeMs !== null) {
      responseHeaders.set('X-Wegent-Gateway-Upstream-Time-Ms', gatewayUpstreamTimeMs.toFixed(2))
      responseHeaders.set('X-Wegent-Gateway-Upstream-Status', String(response.status))
    }

    // Return the proxied response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    if (skillDownloadObservation) {
      const gatewayUpstreamTimeMs = logSkillDownloadObservation(skillDownloadObservation)
      return NextResponse.json(
        { error: 'Failed to proxy request to backend' },
        {
          status: 502,
          headers: {
            'X-Request-ID': skillDownloadObservation.requestId,
            'X-Wegent-Gateway-Upstream-Time-Ms': gatewayUpstreamTimeMs.toFixed(2),
            'X-Wegent-Gateway-Upstream-Status': 'unavailable',
          },
        }
      )
    }
    console.error('[API Proxy] Error proxying request:', error)
    return NextResponse.json({ error: 'Failed to proxy request to backend' }, { status: 502 })
  } finally {
    if (skillDownloadObservation) {
      finishSkillDownloadObservation()
    }
  }
}

// Export handlers for all HTTP methods
export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const PATCH = proxyRequest
export const DELETE = proxyRequest
export const OPTIONS = proxyRequest
