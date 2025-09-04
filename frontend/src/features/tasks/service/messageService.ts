// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { taskApis } from '@/apis/tasks'
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'

/**
 * 发送消息并创建任务
 * @param params 
 * @returns 
 */
export async function sendMessage(params: {
  message: string
  team: Team | null
  repo: GitRepoInfo | null
  branch: GitBranch | null
}) {
  const { message, team, repo, branch } = params
  if (!message.trim() || !team || !repo || !branch) {
    return {
      error: 'Please select Team, repository and branch',
      newTask: null
    }
  }
  try {
    const newTask = await taskApis.createTask({
      title: message.trim().substring(0, 100),
      team_id: team.id,
      git_url: repo.git_url,
      git_repo: repo.git_repo,
      git_repo_id: repo.git_repo_id,
      git_domain: repo.git_domain,
      branch_name: branch.name,
      prompt: message.trim(),
      batch: 0,
      user_id: 0,
      user_name: '',
    })
    return {
      error: '',
      newTask
    }
  } catch (e: any) {
    return {
      error: e?.message || 'Failed to create task',
      newTask: null
    }
  }
}
/**
 * 发送消息并模拟消息流（user/system），返回新消息数组
 */
export async function sendMessageWithSimulate(params: {
  message: string
  team: Team | null
  repo: GitRepoInfo | null
  branch: GitBranch | null
  prevMessages: any[]
}) {
  const { message, team, repo, branch, prevMessages } = params
  if (!message.trim() || !team || !repo || !branch) {
    return {
      error: 'Please select Team, repository and branch',
      messages: [...prevMessages]
    }
  }
  try {
    const newTask = await taskApis.createTask({
      title: message.trim().substring(0, 100),
      team_id: team.id,
      git_url: repo.git_url,
      git_repo: repo.git_repo,
      git_repo_id: repo.git_repo_id,
      git_domain: repo.git_domain,
      branch_name: branch.name,
      prompt: message.trim(),
      batch: 0,
      user_id: 0,
      user_name: '',
    })
    const userMsg = { type: 'user', content: message.trim(), timestamp: Date.now() }
    const sysMsg = { type: 'system', content: 'Task created: ' + newTask.title, timestamp: Date.now() }
    return {
      error: '',
      messages: [...prevMessages, userMsg, sysMsg]
    }
  } catch (e: any) {
    const userMsg = { type: 'user', content: message.trim(), timestamp: Date.now() }
    return {
      error: e?.message || 'Failed to create task',
      messages: [...prevMessages, userMsg]
    }
  }
}