// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { userApis } from '@/apis/user'
import { githubApis } from '@/apis/github'
import { GitInfo, User } from '@/types/api'

/**
 * 获取用户的gitInfo
 */
export async function fetchGitInfo(user: User): Promise<GitInfo[]> {
  return Array.isArray(user.git_info) ? user.git_info : []
}

/**
 * 保存/更新git token
 */
/**
 * 保存/更新git token
 * @param user 当前用户（从 UserContext 获取）
 */
export async function saveGitToken(user: User, git_domain: string, git_token: string): Promise<boolean> {
  try {
    const isValid = await githubApis.validateToken(git_token)
    if (!isValid) return false
    let newGitInfo = Array.isArray(user.git_info) ? [...user.git_info] : []
    const idx = newGitInfo.findIndex(info => info.git_domain === git_domain)
    if (idx >= 0) {
      newGitInfo[idx].git_token = git_token
    } else {
      const type = git_domain.includes('github') ? 'github' : 'gitlab'
      newGitInfo.push({ git_domain, git_token, type })
    }
    await userApis.updateUser({ git_info: newGitInfo })
    return true
  } catch {
    return false
  }
}

/**
 * 删除git token
 */
/**
 * 删除git token
 * @param user 当前用户（从 UserContext 获取）
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