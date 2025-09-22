// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { userApis } from '@/apis/user'
import { githubApis } from '@/apis/github'
import { GitInfo, User } from '@/types/api'

/**
 * Get user's gitInfo
 */
export async function fetchGitInfo(user: User): Promise<GitInfo[]> {
  return Array.isArray(user.git_info) ? user.git_info : []
}

/**
 * Save/Update git token
 */
/**
 * Save/Update git token
 * @param user Current user (from UserContext)
 */
export async function saveGitToken(user: User, git_domain: string, git_token: string): Promise<void> {
  let newGitInfo = Array.isArray(user.git_info) ? [...user.git_info] : []
  const idx = newGitInfo.findIndex(info => info.git_domain === git_domain)
  if (idx >= 0) {
    newGitInfo[idx].git_token = git_token
  } else {
    const type = git_domain.includes('github') ? 'github' : 'gitlab'
    newGitInfo.push({ git_domain, git_token, type })
  }
  await userApis.updateUser({ git_info: newGitInfo })
}

/**
 * Delete git token
 */
/**
 * Delete git token
 * @param user Current user (from UserContext)
 */
export async function deleteGitToken(user: User, git_domain: string): Promise<boolean> {
  try {
    const newGitInfo = Array.isArray(user.git_info)
      ? user.git_info.filter(info => info.git_domain !== git_domain)
      : []
    await userApis.updateUser({ git_info: newGitInfo })
    return true
  } catch {
    return false
  }
}