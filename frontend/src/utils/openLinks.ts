// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TaskDetail, OpenLinks } from '@/types/api'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

/**
 * Calculate open links from task detail data
 */
export function calculateOpenLinks(taskDetail: TaskDetail | null | undefined): OpenLinks | null {
  if (!taskDetail) {
    return null
  }

  const result: OpenLinks = {
    session_id: null,
    vscode_link: null,
    git_link: null,
    git_url: taskDetail.git_url || '',
    target_branch: null,
  }

  // Extract session_id from subtasks executor_name
  if (taskDetail.subtasks && taskDetail.subtasks.length > 0) {
    for (const subtask of taskDetail.subtasks) {
      if (subtask.executor_name) {
        result.session_id = subtask.executor_name
        break
      }
    }
  }

  // Extract target_branch from workbench.git_info
  const workbench = taskDetail.workbench
  if (workbench && workbench.git_info) {
    const source_branch = workbench.git_info.target_branch
    const target_branch = workbench.git_info.source_branch
    result.target_branch = source_branch

    // Build git link based on git type
    const git_domain = taskDetail.git_domain || 'github.com'
    const git_type = git_domain.endsWith('github.com') ? 'github' : 'gitlab'
    const git_repo = taskDetail.git_repo || ''
    const git_url = taskDetail.git_url || ''

    if (target_branch && source_branch && git_repo) {
      // Try to build MR/PR link
      if (git_type === 'gitlab') {
        // GitLab MR link format
        result.git_link = `https://${git_domain}/${git_repo}/-/merge_requests/new?merge_request[source_branch]=${source_branch}&merge_request[target_branch]=${target_branch}`
      } else if (git_type === 'github') {
        // GitHub PR link format
        result.git_link = `https://${git_domain}/${git_repo}/compare/${target_branch}...${source_branch}`
      } else {
        // Gitee PR link format: similar to GitHub
        result.git_link = `https://${git_domain}/${git_repo}/compare/${target_branch}...${source_branch}`
      }
    } else if (target_branch && git_repo) {
      // If only target_branch exists, link to branch
      if (git_type === 'gitlab') {
        result.git_link = `https://${git_domain}/${git_repo}/-/tree/${target_branch}`
      } else {
        result.git_link = `https://${git_domain}/${git_repo}/tree/${target_branch}`
      }
    } else if (git_url) {
      // Fallback to git_url
      result.git_link = git_url
    }
  }

  // Build VSCode link from template
  const vscodeLinkTemplate = getRuntimeConfigSync().vscodeLinkTemplate
  if (vscodeLinkTemplate && result.session_id && result.git_url) {
    const branch = result.target_branch || taskDetail.branch_name || ''
    // Replace placeholders in template
    result.vscode_link = vscodeLinkTemplate
      .replace('{session_id}', encodeURIComponent(result.session_id))
      .replace('{type}', 'wegent')
      .replace('{git_url}', encodeURIComponent(result.git_url))
      .replace('{branch}', encodeURIComponent(branch))
  }

  return result
}
