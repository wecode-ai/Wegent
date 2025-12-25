// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime Configuration API
 *
 * This endpoint provides runtime configuration values that can be changed
 * without rebuilding the application. Environment variables are read at
 * server startup time, not build time.
 *
 * Architecture:
 * - RUNTIME_INTERNAL_API_URL: Used by Next.js server-side rewrites (next.config.js) to proxy to backend
 * - NEXT_PUBLIC_API_URL: Used by browser for direct API calls (empty = use '/api' proxy mode)
 *
 * Recommended setup (browser uses proxy):
 * - Set RUNTIME_INTERNAL_API_URL=http://backend:8000 (for Next.js server to reach backend)
 * - Leave NEXT_PUBLIC_API_URL empty or unset (browser uses '/api' which is proxied)
 *
 * Direct mode setup (browser calls backend directly):
 * - Set NEXT_PUBLIC_API_URL=http://backend:8000 (browser calls backend directly)
 * - RUNTIME_INTERNAL_API_URL is not needed in this case
 */

import { NextResponse } from 'next/server';

export async function GET() {
  // Helper to parse boolean env vars
  const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
    if (value === undefined || value === '') return defaultValue;
    return value.toLowerCase() === 'true';
  };

  return NextResponse.json({
    // Backend API URL for browser
    // Empty string = use '/api' proxy mode (recommended)
    // Full URL = browser calls backend directly (not recommended for same-network deployments)
    apiUrl: process.env.NEXT_PUBLIC_API_URL || '',

    // Socket.IO direct URL - can be changed at runtime
    // Priority: RUNTIME_SOCKET_DIRECT_URL > NEXT_PUBLIC_SOCKET_DIRECT_URL > empty
    // Note: Empty string means use relative path through Next.js proxy
    socketDirectUrl:
      process.env.RUNTIME_SOCKET_DIRECT_URL || process.env.NEXT_PUBLIC_SOCKET_DIRECT_URL || '',

    // Enable chat context feature (knowledge base background)
    // Priority: RUNTIME_ENABLE_CHAT_CONTEXT > NEXT_PUBLIC_ENABLE_CHAT_CONTEXT > false
    enableChatContext: parseBoolean(process.env.RUNTIME_ENABLE_CHAT_CONTEXT, false),
  });
}
