// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill Market Availability Check API
 *
 * This endpoint checks if a skill market provider is available.
 * Returns { available: true } if a provider is registered, otherwise { available: false }.
 *
 * If you have an extension market implementation, you can register it here.
 */

import { NextResponse } from 'next/server'
import { skillMarketProviderRegistry } from '../provider'

export async function GET() {
  try {
    // If you have an extension market implementation, you can register it here.

    // Check if a provider is available
    const available = skillMarketProviderRegistry.hasProvider()

    return NextResponse.json({ available })
  } catch (error) {
    console.error('[SkillMarket] Error checking availability:', error)
    return NextResponse.json({ available: false })
  }
}
