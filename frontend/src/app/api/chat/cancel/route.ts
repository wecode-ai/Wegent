// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for cancelling chat stream.
 *
 * This route proxies cancel requests to the backend.
 */

import { NextRequest, NextResponse } from 'next/server';

// Get backend URL from environment
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function POST(request: NextRequest) {
  try {
    // Get the request body
    const body = await request.json();

    // Get authorization header
    const authHeader = request.headers.get('Authorization');

    // Forward request to backend
    const backendResponse = await fetch(`${BACKEND_URL}/api/chat/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader && { Authorization: authHeader }),
      },
      body: JSON.stringify(body),
    });

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text();
      return new NextResponse(errorText, {
        status: backendResponse.status,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    const data = await backendResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Chat cancel proxy error:', error);
    return NextResponse.json({ error: 'Failed to proxy chat cancel request' }, { status: 500 });
  }
}
