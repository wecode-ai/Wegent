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
      const response = await apiClient.get<GitHubTokenValidationResponse>(`/github/validate-token?token=${encodeURIComponent(token)}`)
      return (response as GitHubTokenValidationResponse).valid === true
    } catch (error) {
      console.error('Token validation failed:', error)
      return false
    }
  },

  async getRepositories(): Promise<GitHubRepositoriesResponse> {
    return await apiClient.get('/github/repositories')
  },

  async searchRepositories(query: string): Promise<GitRepoInfo[]> {
    // 增加 timeout=30 参数，兼容后端接口
    return await apiClient.get(`/github/repositories/search?q=${encodeURIComponent(query)}&timeout=30`);
  },

  async getBranches(repoName: string): Promise<GitBranchesResponse> {
    return apiClient.get(`/github/repositories/branches?git_repo=${encodeURIComponent(repoName)}`)
  }
}