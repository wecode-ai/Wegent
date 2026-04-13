// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GitRepoInfo } from '@/types/api'

/**
 * Build a stable repository identity across multi-provider / multi-domain setups.
 * git_repo_id is not globally unique across different git domains.
 */
export function getRepositoryIdentity(
  repo: Pick<GitRepoInfo, 'type' | 'git_domain' | 'git_repo_id'>
): string {
  return `${repo.type}:${repo.git_domain}:${repo.git_repo_id}`
}
