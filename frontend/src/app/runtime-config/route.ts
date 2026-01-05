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
    enableChatContext:
      parseBoolean(process.env.RUNTIME_ENABLE_CHAT_CONTEXT, false) ||
      parseBoolean(process.env.NEXT_PUBLIC_ENABLE_CHAT_CONTEXT, false),

    // Login mode: 'password', 'oidc', or 'all'
    // Priority: RUNTIME_LOGIN_MODE > NEXT_PUBLIC_LOGIN_MODE > 'all'
    loginMode: process.env.RUNTIME_LOGIN_MODE || process.env.NEXT_PUBLIC_LOGIN_MODE || 'all',

    // OIDC login button text
    // Priority: RUNTIME_OIDC_LOGIN_TEXT > NEXT_PUBLIC_OIDC_LOGIN_TEXT > empty
    oidcLoginText:
      process.env.RUNTIME_OIDC_LOGIN_TEXT || process.env.NEXT_PUBLIC_OIDC_LOGIN_TEXT || '',

    // Enable display quotas in frontend
    // Priority: RUNTIME_ENABLE_DISPLAY_QUOTAS > NEXT_PUBLIC_FRONTEND_ENABLE_DISPLAY_QUOTAS > false
    enableDisplayQuotas:
      process.env.RUNTIME_ENABLE_DISPLAY_QUOTAS === 'enable' ||
      process.env.NEXT_PUBLIC_FRONTEND_ENABLE_DISPLAY_QUOTAS === 'enable',

    // Enable Wiki module
    // Priority: RUNTIME_ENABLE_WIKI > NEXT_PUBLIC_ENABLE_WIKI > true (enabled by default)
    enableWiki:
      process.env.RUNTIME_ENABLE_WIKI !== 'false' &&
      process.env.NEXT_PUBLIC_ENABLE_WIKI !== 'false',

    // VSCode link template for deep linking
    // Priority: RUNTIME_VSCODE_LINK_TEMPLATE > NEXT_PUBLIC_VSCODE_LINK_TEMPLATE > empty
    vscodeLinkTemplate:
      process.env.RUNTIME_VSCODE_LINK_TEMPLATE ||
      process.env.NEXT_PUBLIC_VSCODE_LINK_TEMPLATE ||
      '',

    // Feedback URL for issue reporting
    // Priority: RUNTIME_FEEDBACK_URL > NEXT_PUBLIC_FEEDBACK_URL > default
    feedbackUrl:
      process.env.RUNTIME_FEEDBACK_URL ||
      process.env.NEXT_PUBLIC_FEEDBACK_URL ||
      'https://github.com/wecode-ai/wegent/issues/new',

    // Documentation URL
    // Priority: RUNTIME_DOCS_URL > NEXT_PUBLIC_DOCS_URL > default
    docsUrl:
      process.env.RUNTIME_DOCS_URL ||
      process.env.NEXT_PUBLIC_DOCS_URL ||
      'https://github.com/wecode-ai/Wegent',

    // OpenTelemetry configuration
    // Priority: RUNTIME_OTEL_* > NEXT_PUBLIC_OTEL_* > defaults
    otelEnabled:
      parseBoolean(process.env.RUNTIME_OTEL_ENABLED, false) ||
      parseBoolean(process.env.NEXT_PUBLIC_OTEL_ENABLED, false),

    otelServiceName:
      process.env.RUNTIME_OTEL_SERVICE_NAME ||
      process.env.NEXT_PUBLIC_OTEL_SERVICE_NAME ||
      'wegent-frontend',

    otelCollectorEndpoint:
      process.env.RUNTIME_OTEL_COLLECTOR_ENDPOINT ||
      process.env.NEXT_PUBLIC_OTEL_COLLECTOR_ENDPOINT ||
      'http://localhost:4318',
  });
}
