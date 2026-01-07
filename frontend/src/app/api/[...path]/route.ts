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
 */

import { NextRequest, NextResponse } from 'next/server'
import { getInternalApiUrl } from '@/lib/server-config'

/**
 * Proxy handler for all HTTP methods
 */
async function proxyRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await params
  const backendUrl = getInternalApiUrl()
  const targetPath = `/api/${path.join('/')}`
  const targetUrl = new URL(targetPath, backendUrl)

  // Preserve query parameters
  const searchParams = request.nextUrl.searchParams
  searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value)
  })

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

    // Return the proxied response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    console.error('[API Proxy] Error proxying request:', error)
    return NextResponse.json({ error: 'Failed to proxy request to backend' }, { status: 502 })
  }
}

// Export handlers for all HTTP methods
export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const PATCH = proxyRequest
export const DELETE = proxyRequest
export const OPTIONS = proxyRequest
