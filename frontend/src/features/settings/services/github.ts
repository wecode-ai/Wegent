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
  const newGitInfo = Array.isArray(user.git_info) ? [...user.git_info] : [];
  const idx = newGitInfo.findIndex(info => info.git_domain === git_domain);

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

  if (idx >= 0) {
    newGitInfo[idx].git_token = git_token;
    if (username !== undefined) {
      newGitInfo[idx].username = username;
    }
    newGitInfo[idx].type = detectedType;
  } else {
    const newEntry: GitInfo = { git_domain, git_token, type: detectedType };
    if (username !== undefined && username !== '') {
      newEntry.username = username;
    }
    newGitInfo.push(newEntry);
  }
  await userApis.updateUser({ git_info: newGitInfo });
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
      : [];
    await userApis.updateUser({ git_info: newGitInfo });
    return true;
  } catch {
    return false;
  }
}
