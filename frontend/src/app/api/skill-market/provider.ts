// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill Market Provider Interface and Registry
 *
 * This module defines the abstract interface for skill market providers
 * and provides a registry mechanism for dynamic provider registration.
 *
 * The actual provider implementation is loaded in available/route.ts
 * which initializes the internal provider on first request.
 */

import { NextRequest } from 'next/server'

/**
 * Search parameters for skill market
 */
export interface SearchParams {
  /** Keyword search */
  keyword?: string
  /** Tag filter */
  tags?: string
  /** Page number */
  page: number
  /** Page size */
  pageSize: number
  /** User making the request */
  user?: string
}

/**
 * Skill information from market
 */
export interface MarketSkill {
  /** Unique skill identifier */
  skillKey: string
  /** Skill name */
  name: string
  /** Skill description */
  description: string
  /** Author name */
  author: string
  /** Visibility (public/private) */
  visibility: string
  /** Tags */
  tags: string[]
  /** Version */
  version: string
  /** Download count */
  downloadCount: number
  /** Creation time */
  createdAt: string
}

/**
 * Search result from skill market
 */
export interface SearchResult {
  /** Total number of skills */
  total: number
  /** Current page */
  page: number
  /** Page size */
  pageSize: number
  /** List of skills */
  skills: MarketSkill[]
}

/**
 * Download result from skill market
 */
export interface DownloadResult {
  /** Skill file blob */
  blob: Blob
  /** Suggested filename */
  filename: string
}

/**
 * Skill Market Provider Interface
 *
 * Implement this interface to create a new skill market provider.
 * The provider should handle all communication with the external skill market service.
 */
export interface ISkillMarketProvider {
  /** Provider name for display */
  readonly name: string

  /**
   * Search skills in the market
   * @param params Search parameters
   * @returns Search result with skills list
   */
  search(params: SearchParams): Promise<SearchResult>

  /**
   * Download a skill from the market
   * @param skillKey Unique skill identifier
   * @param user Optional user identifier
   * @returns Download result with blob and filename
   */
  download(skillKey: string, user?: string): Promise<DownloadResult>
}

/**
 * Skill Market Provider Registry
 *
 * Manages the registered skill market provider.
 * Only one provider can be active at a time.
 * If multiple providers are registered, the last one wins.
 */
class SkillMarketProviderRegistry {
  private provider: ISkillMarketProvider | null = null

  /**
   * Register a skill market provider
   * If a provider is already registered, it will be replaced.
   * @param provider The provider to register
   */
  register(provider: ISkillMarketProvider): void {
    console.log(`[SkillMarketRegistry] Registering provider: ${provider.name}`)
    this.provider = provider
  }

  /**
   * Get the registered provider
   * @returns The registered provider or null if none
   */
  getProvider(): ISkillMarketProvider | null {
    return this.provider
  }

  /**
   * Check if a provider is registered
   * @returns true if a provider is registered
   */
  hasProvider(): boolean {
    return this.provider !== null
  }

  /**
   * Clear the registered provider
   */
  clear(): void {
    this.provider = null
  }
}

// Singleton instance
export const skillMarketProviderRegistry = new SkillMarketProviderRegistry()

/**
 * Parse search parameters from NextRequest
 * @param request The incoming request
 * @returns Parsed search parameters
 */
export function parseSearchParams(request: NextRequest): SearchParams {
  const searchParams = request.nextUrl.searchParams
  return {
    keyword: searchParams.get('keyword') || undefined,
    tags: searchParams.get('tags') || undefined,
    page: parseInt(searchParams.get('page') || '1', 10),
    pageSize: parseInt(searchParams.get('pageSize') || '20', 10),
    user: searchParams.get('user') || undefined,
  }
}
