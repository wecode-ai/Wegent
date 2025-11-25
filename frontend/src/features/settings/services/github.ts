// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { userApis } from '@/apis/user';
import { GitInfo, User } from '@/types/api';

/**
 * Get user's gitInfo
 */
export async function fetchGitInfo(user: User): Promise<GitInfo[]> {
  return Array.isArray(user.git_info) ? user.git_info : [];
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
  type?: GitInfo['type']
): Promise<void> {
  // Auto-detect type if not provided
  let detectedType: GitInfo['type'] = type || 'gitlab';
  if (!type) {
    if (git_domain.includes('github')) {
      detectedType = 'github';
    } else if (git_domain.includes('gitlab')) {
      detectedType = 'gitlab';
    } else if (git_domain.includes('gitee')) {
      detectedType = 'gitee';
    } else if (git_domain.includes('gerrit')) {
      detectedType = 'gerrit';
    }
  }

  // Only send the git_info item being saved/updated
  const gitInfoToSave: GitInfo = {
    git_domain,
    git_token,
    type: detectedType,
  };

  // Add user_name if provided
  if (username !== undefined && username !== '') {
    gitInfoToSave.user_name = username;
  }

  // Send only the single git_info item being saved
  await userApis.updateUser({ git_info: [gitInfoToSave] });
}

/**
 * Delete git token
 * @param user Current user (from UserContext)
 * @param git_domain Git domain to delete
 */
export async function deleteGitToken(user: User, git_domain: string): Promise<boolean> {
  try {
    await userApis.deleteGitToken(git_domain);
    return true;
  } catch {
    return false;
  }
}
