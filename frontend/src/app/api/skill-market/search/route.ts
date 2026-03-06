// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill Market Search API Route
 *
 * This route handles skill search requests by delegating to the registered
 * skill market provider. The provider is initialized in available/route.ts
 * which is called first by the frontend.
 *
 * If no provider is registered, a friendly error message is returned.
 */

import { NextRequest, NextResponse } from 'next/server'
import { skillMarketProviderRegistry, parseSearchParams } from '../provider'

export async function GET(request: NextRequest): Promise<Response> {
  // Get the registered provider (initialized by available/route.ts)
  const provider = skillMarketProviderRegistry.getProvider()

  if (!provider) {
    console.log('[SkillMarket] No provider registered, returning error')
    return NextResponse.json(
      {
        error: 'Skill market not available',
        message:
          'No skill market provider is configured. This feature requires a skill market provider to be installed.',
      },
      { status: 503 }
    )
  }

  // Parse search parameters from request
  const params = parseSearchParams(request)

  console.log('[SkillMarket] Searching skills:', {
    provider: provider.name,
    params,
  })

  try {
    const result = await provider.search(params)

    return NextResponse.json({
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      skills: result.skills,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[SkillMarket] Search error:', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })

    // Determine appropriate status code based on error
    let statusCode = 500
    if (errorMessage.includes('Network error')) {
      statusCode = 502
    } else if (errorMessage.includes('HTTP 4')) {
      statusCode = 400
    }

    return NextResponse.json(
      {
        error: errorMessage,
      },
      { status: statusCode }
    )
  }
}
