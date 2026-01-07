// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Utility function for creating streaming proxy responses.
 *
 * This module provides a reusable function for proxying SSE (Server-Sent Events)
 * streams from the backend to the frontend, bypassing Next.js rewrites which
 * don't support streaming.
 */

import { NextRequest } from 'next/server'
import { getInternalApiUrl } from './server-config'

export interface StreamProxyOptions {
  /** Custom headers to forward to backend */
  customHeaders?: Record<string, string>
  /** Headers to extract from backend response and forward to client */
  forwardHeaders?: string[]
}

/**
 * Create a streaming proxy response to the backend.
 *
 * @param request - The incoming Next.js request
 * @param backendPath - The backend API path (e.g., '/api/chat/stream')
 * @param options - Optional configuration
 * @returns A streaming Response object
 */
export async function createStreamProxy(
  request: NextRequest,
  backendPath: string,
  options: StreamProxyOptions = {}
): Promise<Response> {
  try {
    // Get the request body
    const body = await request.json()

    // Get authorization header
    const authHeader = request.headers.get('Authorization')

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(authHeader && { Authorization: authHeader }),
      ...options.customHeaders,
    }

    // Forward request to backend
    const backendResponse = await fetch(`${getInternalApiUrl()}${backendPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text()
      return new Response(errorText, {
        status: backendResponse.status,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }

    // Check if response body exists
    if (!backendResponse.body) {
      return new Response('No response body from backend', { status: 500 })
    }

    // Create a TransformStream to pass through the data
    const { readable, writable } = new TransformStream()

    // Pipe the backend response to the client
    // This is done asynchronously to allow streaming
    ;(async () => {
      const reader = backendResponse.body!.getReader()
      const writer = writable.getWriter()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            await writer.close()
            break
          }
          await writer.write(value)
        }
      } catch (error) {
        console.error('Stream error:', error)
        await writer.abort(error as Error)
      }
    })()

    // Build response headers
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }

    // Forward specified headers from backend response
    if (options.forwardHeaders) {
      for (const headerName of options.forwardHeaders) {
        const headerValue = backendResponse.headers.get(headerName)
        if (headerValue) {
          responseHeaders[headerName] = headerValue
        }
      }
    }

    // Return streaming response with proper headers
    return new Response(readable, { headers: responseHeaders })
  } catch (error) {
    console.error('Stream proxy error:', error)
    return new Response(JSON.stringify({ error: 'Failed to proxy stream' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }
}
