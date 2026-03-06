// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill Market Download API Route
 *
 * This route handles skill download requests by delegating to the registered
 * skill market provider. The provider is initialized in available/route.ts
 * which is called first by the frontend.
 *
 * If no provider is registered, a friendly error message is returned.
 */

import { NextRequest, NextResponse } from 'next/server'
import { skillMarketProviderRegistry } from '../../provider'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ skillKey: string }> }
): Promise<Response> {
  const { skillKey } = await params
  const searchParams = request.nextUrl.searchParams
  const user = searchParams.get('user') || undefined

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

  console.log('[SkillMarket] Downloading skill:', {
    provider: provider.name,
    skillKey,
    user,
  })

  try {
    const result = await provider.download(skillKey, user)

    return new Response(result.blob, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[SkillMarket] Download error:', {
      skillKey,
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
        details: { skillKey },
      },
      { status: statusCode }
    )
  }
}
