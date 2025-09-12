// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { taskApis } from '@/apis/tasks'
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'

/**
 * Send message:
 * - 若传入 task_id，则直接调用 /api/tasks/{task_id} 发送消息
 * - 若未传入 task_id，则先创建任务 (/api/tasks) 获取 task_id，再调用 /api/tasks/{task_id} 发送消息
 */
export async function sendMessage(params: {
  message: string
  team: Team | null
  repo: GitRepoInfo | null
  branch: GitBranch | null
  task_id?: number
}) {
  const { message, team, repo, branch, task_id } = params
  const trimmed = message?.trim() ?? ''

  if (!trimmed) {
    return { error: 'Message is empty', newTask: null }
  }

  // 若没有 task_id，则需要完整上下文用于首次发送
  if ((!task_id || !Number.isFinite(task_id)) && (!team)) {
    return { error: 'Please select Team, repository and branch', newTask: null }
  }

  // 统一委托给 taskApis.sendTaskMessage（内部负责是否先创建任务）
  const payload = {
    task_id: Number.isFinite(task_id as number) ? (task_id as number) : undefined,
    message: trimmed,
    title: trimmed.substring(0, 100),
    team_id: team?.id ?? 0,
    git_url: repo?.git_url ?? '',
    git_repo: repo?.git_repo ?? '',
    git_repo_id: repo?.git_repo_id ?? 0,
    git_domain: repo?.git_domain ?? '',
    branch_name: branch?.name ?? '',
    prompt: trimmed,
    batch: 0,
    user_id: 0,
    user_name: '',
  }

  try {
    const { task_id } = await taskApis.sendTaskMessage(payload)
    return { error: '', newTask: { task_id } }
  } catch (e: any) {
    return { error: e?.message || 'Failed to send message', newTask: null }
  }
}