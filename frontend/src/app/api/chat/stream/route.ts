// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for streaming chat.
 *
 * This route manually proxies streaming requests to the backend,
 * bypassing Next.js rewrites which don't support streaming.
 */

import { NextRequest } from 'next/server';

// Get backend URL from environment
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function POST(request: NextRequest) {
  try {
    // Get the request body
    const body = await request.json();

    // Get authorization header
    const authHeader = request.headers.get('Authorization');

    // Forward request to backend
    const backendResponse = await fetch(`${BACKEND_URL}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader && { Authorization: authHeader }),
      },
      body: JSON.stringify(body),
    });

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text();
      return new Response(errorText, {
        status: backendResponse.status,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    // Check if response body exists
    if (!backendResponse.body) {
      return new Response('No response body from backend', { status: 500 });
    }

    // Create a TransformStream to pass through the data
    const { readable, writable } = new TransformStream();

    // Pipe the backend response to the client
    // This is done asynchronously to allow streaming
    (async () => {
      const reader = backendResponse.body!.getReader();
      const writer = writable.getWriter();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            break;
          }
          await writer.write(value);
        }
      } catch (error) {
        console.error('Stream error:', error);
        await writer.abort(error as Error);
      }
    })();

    // Get task ID and subtask ID from backend response headers
    const taskId = backendResponse.headers.get('X-Task-Id');
    const subtaskId = backendResponse.headers.get('X-Subtask-Id');

    // Return streaming response with proper headers
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        // Forward task ID and subtask ID from backend
        ...(taskId && { 'X-Task-Id': taskId }),
        ...(subtaskId && { 'X-Subtask-Id': subtaskId }),
      },
    });
  } catch (error) {
    console.error('Chat stream proxy error:', error);
    return new Response(JSON.stringify({ error: 'Failed to proxy chat stream' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
