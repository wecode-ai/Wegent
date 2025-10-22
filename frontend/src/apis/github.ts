// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import type { GitRepoInfo, GitBranch } from '@/types/api'

// GitHub Response Types
export type GitHubRepositoriesResponse = GitRepoInfo[]

export type GitBranchesResponse = GitBranch[]

interface GitHubTokenValidationResponse {
  valid: boolean;
  user: any | null;
}

// GitHub Services
export const githubApis = {
  async validateToken(token: string): Promise<boolean> {
    try {
      const response = await apiClient.get<GitHubTokenValidationResponse>(`/git/validate-token?token=${encodeURIComponent(token)}`)
      return (response as GitHubTokenValidationResponse).valid === true
    } catch (error) {
      console.error('Token validation failed:', error)
      return false
    }
  },

  async getRepositories(): Promise<GitHubRepositoriesResponse> {
    return await apiClient.get('/git/repositories')
  },

  async searchRepositories(query: string): Promise<GitRepoInfo[]> {
    // Add timeout=30 parameter to be compatible with backend interface
    return await apiClient.get(`/git/repositories/search?q=${encodeURIComponent(query)}&timeout=30`);
  },

  async getBranches(repo: GitRepoInfo): Promise<GitBranchesResponse> {
    return apiClient.get(`/git/repositories/branches?git_repo=${encodeURIComponent(repo.git_repo)}&type=${repo.type}&git_domain=${encodeURIComponent(repo.git_domain)}`)
  }
}