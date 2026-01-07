// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import type { GitRepoInfo, GitBranch } from '@/types/api'

// Maximum repositories to request per API call (backend supports up to 5000)
const REPOSITORY_FETCH_LIMIT = 5000

// GitHub Response Types
export type GitHubRepositoriesResponse = GitRepoInfo[]

export type GitBranchesResponse = GitBranch[]

interface GitHubTokenValidationResponse {
  valid: boolean
  user: unknown | null
}

// GitHub Services
export const githubApis = {
  async validateToken(token: string): Promise<boolean> {
    try {
      const response = await apiClient.get<GitHubTokenValidationResponse>(
        `/git/validate-token?token=${encodeURIComponent(token)}`
      )
      return (response as GitHubTokenValidationResponse).valid === true
    } catch (error) {
      console.error('Token validation failed:', error)
      return false
    }
  },

  async getRepositories(): Promise<GitHubRepositoriesResponse> {
    // Request all user repositories in one request (backend caches the full list)
    return await apiClient.get(`/git/repositories?limit=${REPOSITORY_FETCH_LIMIT}`)
  },

  // Unified search API: supports optional precise search via fullmatch and configurable timeout
  async searchRepositories(
    query: string,
    opts?: { fullmatch?: boolean; timeout?: number }
  ): Promise<GitRepoInfo[]> {
    const timeout = opts?.timeout ?? 30
    const params = new URLSearchParams({
      q: query,
      timeout: String(timeout),
    })
    if (opts?.fullmatch) {
      params.append('fullmatch', '1')
    }
    return await apiClient.get(`/git/repositories/search?${params.toString()}`)
  },

  async getBranches(repo: GitRepoInfo): Promise<GitBranchesResponse> {
    return apiClient.get(
      `/git/repositories/branches?git_repo=${encodeURIComponent(repo.git_repo)}&type=${repo.type}&git_domain=${encodeURIComponent(repo.git_domain)}`
    )
  },

  /**
   * Force refresh user's repository cache.
   * Clears backend Redis cache to fetch fresh data from Git providers.
   */
  async refreshRepositories(): Promise<{
    success: boolean
    message: string
    cleared_domains: string[]
  }> {
    return await apiClient.post('/git/repositories/refresh')
  },
}
