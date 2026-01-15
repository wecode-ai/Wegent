// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { userApis } from '@/apis/user'
import { GitInfo, User } from '@/types/api'

/**
 * Get user's gitInfo
 */
export async function fetchGitInfo(user: User): Promise<GitInfo[]> {
  return Array.isArray(user.git_info) ? user.git_info : []
}

/**
 * Save/Update git token
 * @param user Current user (from UserContext)
 */
export async function saveGitToken(
  user: User,
  git_domain: string,
  git_token: string,
  username?: string,
  type?: GitInfo['type'],
  existingId?: string,
  authType?: 'digest' | 'basic'
): Promise<void> {
  // Auto-detect type if not provided
  let detectedType: GitInfo['type'] = type || 'gitlab'
  if (!type) {
    if (git_domain.includes('github')) {
      detectedType = 'github'
    } else if (git_domain.includes('gitlab')) {
      detectedType = 'gitlab'
    } else if (git_domain.includes('gitee')) {
      detectedType = 'gitee'
    } else if (git_domain.includes('gitea')) {
      detectedType = 'gitea'
    } else if (git_domain.includes('gerrit')) {
      detectedType = 'gerrit'
    }
  }

  // Only send the git_info item being saved/updated
  const gitInfoToSave: GitInfo = {
    git_domain,
    git_token,
    type: detectedType,
  }

  // Add id if editing existing record (for update instead of create)
  if (existingId) {
    gitInfoToSave.id = existingId
  }

  // Add user_name if provided
  if (username !== undefined && username !== '') {
    gitInfoToSave.user_name = username
  }

  // Add auth_type for Gerrit (always set to ensure value is preserved on updates)
  if (detectedType === 'gerrit') {
    gitInfoToSave.auth_type = authType || 'digest'
  }

  // Send only the single git_info item being saved
  await userApis.updateUser({ git_info: [gitInfoToSave] })
}

/**
 * Delete git token
 * @param user Current user (from UserContext)
 * @param gitInfo Git info to delete (uses id for precise deletion, falls back to domain)
 */
export async function deleteGitToken(user: User, gitInfo: GitInfo): Promise<boolean> {
  try {
    await userApis.deleteGitToken(gitInfo.git_domain, gitInfo.id)
    return true
  } catch {
    return false
  }
}
