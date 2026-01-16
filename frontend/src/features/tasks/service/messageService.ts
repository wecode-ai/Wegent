// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team, GitRepoInfo, GitBranch, TaskDetail, Bot } from '@/types/api'
import { taskApis, CreateTaskRequest } from '@/apis/tasks'

/**
 * Check if a team uses Chat Shell type (supports direct streaming chat via WebSocket).
 * This function checks multiple sources to determine if the team is a Chat Shell:
 * 1. team.agent_type === 'chat' (primary check)
 * 2. team.bots[0].bot.shell_type === 'Chat' (fallback for task detail teams)
 *
 * NOTE: Chat Shell now uses WebSocket for streaming instead of SSE.
 * The streaming is handled by ChatStreamContext, not this service.
 *
 * @param team - Team to check
 * @returns true if the team uses Chat Shell
 */
export function isChatShell(team: Team | null): boolean {
  if (!team) return false

  // Primary check: agent_type field (case-insensitive)
  if (team.agent_type?.toLowerCase() === 'chat') {
    return true
  }

  // Fallback: check first bot's shell_type (for task detail teams where agent_type may be null)
  // This handles the case where team is from task detail API which may not include agent_type
  if (team.bots && team.bots.length > 0) {
    const firstBot = team.bots[0]
    // Check bot.shell_type (from BotSummary in TeamBot)
    if (firstBot.bot?.shell_type?.toLowerCase() === 'chat') {
      return true
    }
  }

  return false
}
/**
/**
 * Check if a task uses Chat Shell type based on subtask bot information.
 * This is useful when team.agent_type is not available but subtask bots have shell_type.
 *
 * @param taskDetail - Task detail to check
 * @returns true if the task uses Chat Shell
 */
export function isTaskChatShell(taskDetail: TaskDetail | null): boolean {
  if (!taskDetail) return false

  // First check team's agent_type
  if (isChatShell(taskDetail.team)) {
    return true
  }

  // Fallback: check subtask bots' shell_type
  if (taskDetail.subtasks && taskDetail.subtasks.length > 0) {
    for (const subtask of taskDetail.subtasks) {
      if (subtask.bots && subtask.bots.length > 0) {
        for (const bot of subtask.bots) {
          // Bot in subtask has shell_type directly (not nested in bot.bot)
          if ((bot as Bot).shell_type?.toLowerCase() === 'chat') {
            return true
          }
        }
      }
    }
  }

  return false
}

/**
 * Send message result type
 */
export interface SendMessageResult {
  error: string
  newTask: { task_id: number } | null
}

/**
 * Send message for non-Chat Shell teams.
 *
 * NOTE: For Chat Shell teams, use ChatStreamContext.startStream() instead.
 * This function is only for non-streaming task creation (e.g., code tasks, Dify, etc.)
 *
 * @param params - Message parameters
 * @returns Result with error message or new task info
 */
export async function sendMessage(params: {
  message: string
  team: Team | null
  repo: GitRepoInfo | null
  branch: GitBranch | null
  task_id?: number
  taskType?: 'chat' | 'code'
  title?: string
  model_id?: string
  force_override_bot_model?: boolean
}): Promise<SendMessageResult> {
  const {
    message,
    team,
    repo,
    branch,
    task_id,
    taskType = 'chat',
    title,
    model_id,
    force_override_bot_model,
  } = params
  const trimmed = message?.trim() ?? ''

  if (!trimmed) {
    return { error: 'Message is empty', newTask: null }
  }

  // If there is no task_id, a complete context is required for the first send
  if ((!task_id || !Number.isFinite(task_id)) && !team) {
    return { error: 'Please select Team', newTask: null }
  }

  // For code type tasks, repository is required
  if (taskType === 'code' && !repo) {
    return { error: 'Please select a repository for code tasks', newTask: null }
  }

  // Unified delegation to taskApis.sendTaskMessage (internally handles whether to create a task first)
  const payload: { task_id?: number; message: string } & CreateTaskRequest = {
    task_id: Number.isFinite(task_id as number) ? (task_id as number) : undefined,
    message: trimmed,
    title: title || trimmed.substring(0, 100),
    team_id: team?.id ?? 0,
    git_url: repo?.git_url ?? '',
    git_repo: repo?.git_repo ?? '',
    git_repo_id: repo?.git_repo_id ?? 0,
    git_domain: repo?.git_domain ?? '',
    branch_name: branch?.name ?? '',
    prompt: trimmed,
    task_type: taskType,
    batch: 0,
    user_id: 0,
    user_name: '',
    model_id: model_id,
    force_override_bot_model: force_override_bot_model,
  }

  try {
    const { task_id } = await taskApis.sendTaskMessage(payload)
    return { error: '', newTask: { task_id } }
  } catch (error) {
    return { error: (error as Error)?.message || 'Failed to send message', newTask: null }
  }
}
