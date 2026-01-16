// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for proxying group chat SSE stream.
 *
 * @deprecated This SSE proxy route is deprecated. Group chat streaming now uses
 * WebSocket via the global Socket.IO connection (see `useGroupChatStream` hook).
 * This route is kept for backward compatibility but will be removed in a future version.
 *
 * This route proxies SSE requests to the backend, reading the auth token
 * from cookies since EventSource API doesn't support custom headers.
 */

import { NextRequest } from 'next/server'
import { getInternalApiUrl } from '@/lib/server-config'

export async function GET(request: NextRequest) {
  try {
    // Get query parameters
    const { searchParams } = new URL(request.url)
    const taskId = searchParams.get('task_id')
    const subtaskId = searchParams.get('subtask_id')
    const offset = searchParams.get('offset') || '0'

    if (!taskId || !subtaskId) {
      return new Response(JSON.stringify({ error: 'Missing task_id or subtask_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get auth token from query parameter (since EventSource doesn't support custom headers)
    const token = searchParams.get('token')

    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized - missing token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Build backend URL
    const backendUrl = `${getInternalApiUrl()}/api/subtasks/tasks/${taskId}/stream/subscribe?subtask_id=${subtaskId}&offset=${offset}`

    // Forward request to backend with Authorization header
    const backendResponse = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
    })

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text()
      return new Response(errorText, {
        status: backendResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Check if response body exists
    if (!backendResponse.body) {
      return new Response('No response body from backend', { status: 500 })
    }

    // Create a TransformStream to pass through the data
    const { readable, writable } = new TransformStream()

    // Pipe the backend response to the client
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
        console.error('SSE stream error:', error)
        await writer.abort(error as Error)
      }
    })()

    // Return streaming response with proper headers
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    console.error('SSE stream proxy error:', error)
    return new Response(JSON.stringify({ error: 'Failed to proxy SSE stream' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
