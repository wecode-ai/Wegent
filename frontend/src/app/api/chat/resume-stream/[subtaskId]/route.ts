// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for resuming streaming chat.
 *
 * @deprecated This SSE-based resume-stream route is deprecated. Chat streaming now uses
 * WebSocket via the global Socket.IO connection. For stream recovery, use the
 * `getStreamingContent` API to fetch accumulated content, then reconnect via WebSocket.
 * This route is kept for backward compatibility but will be removed in a future version.
 *
 * This proxies requests to the backend's resume-stream endpoint,
 * allowing users to refresh the page and continue receiving streaming content.
 */

import { NextRequest } from 'next/server'
import { getInternalApiUrl } from '@/lib/server-config'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subtaskId: string }> }
) {
  const { subtaskId } = await params
  const token = request.headers.get('authorization')

  try {
    const backendUrl = `${getInternalApiUrl()}/api/chat/resume-stream/${subtaskId}`

    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'text/event-stream',
        ...(token && { Authorization: token }),
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      return new Response(errorText, {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Return the SSE stream
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    console.error('Error in resume-stream proxy:', error)
    return new Response(JSON.stringify({ error: 'Failed to resume stream' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
