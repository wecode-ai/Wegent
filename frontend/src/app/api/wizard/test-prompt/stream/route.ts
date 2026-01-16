// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for streaming wizard test-prompt.
 *
 * This route proxies streaming requests to the backend for testing
 * system prompts in the wizard.
 */

import { NextRequest } from 'next/server'
import { createStreamProxy } from '@/lib/stream-proxy'

export async function POST(request: NextRequest) {
  return createStreamProxy(request, '/api/wizard/test-prompt/stream')
}

// Set max duration for serverless function (Vercel/Edge)
export const maxDuration = 60
