// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team, GitRepoInfo, GitBranch } from '@/types/api';
import { taskApis, CreateTaskRequest } from '@/apis/tasks';

/**
 * Send message:
 * - If task_id is provided, directly call /api/tasks/{task_id} to send the message
 * - If task_id is not provided, create a task (/api/tasks) to get task_id, then call /api/tasks/{task_id} to send the message
 */
export async function sendMessage(params: {
  message: string;
  team: Team | null;
  repo: GitRepoInfo | null;
  branch: GitBranch | null;
  task_id?: number;
  taskType?: 'chat' | 'code';
  model_id?: string;
  force_override_bot_model?: boolean;
}) {
  const {
    message,
    team,
    repo,
    branch,
    task_id,
    taskType = 'chat',
    model_id,
    force_override_bot_model,
  } = params;
  const trimmed = message?.trim() ?? '';

  if (!trimmed) {
    return { error: 'Message is empty', newTask: null };
  }

  // If there is no task_id, a complete context is required for the first send
  if ((!task_id || !Number.isFinite(task_id)) && !team) {
    return { error: 'Please select Team, repository and branch', newTask: null };
  }

  // For code type tasks, repository is required
  if (taskType === 'code' && !repo) {
    return { error: 'Please select a repository for code tasks', newTask: null };
  }

  // Unified delegation to taskApis.sendTaskMessage (internally handles whether to create a task first)
  const payload: { task_id?: number; message: string } & CreateTaskRequest = {
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
    task_type: taskType,
    batch: 0,
    user_id: 0,
    user_name: '',
    model_id: model_id,
    force_override_bot_model: force_override_bot_model,
  };

  try {
    const { task_id } = await taskApis.sendTaskMessage(payload);
    return { error: '', newTask: { task_id } };
  } catch (error) {
    return { error: (error as Error)?.message || 'Failed to send message', newTask: null };
  }
}
