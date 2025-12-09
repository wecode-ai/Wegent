// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';
import { getToken } from './user';
import { Task, PaginationParams, TaskStatus, SuccessMessage, TaskDetail } from '../types/api';

// Task Request/Response Types
export interface CreateTaskRequest {
  title: string;
  team_id: number;
  git_url: string;
  git_repo: string;
  git_repo_id: number;
  git_domain: string;
  branch_name: string;
  prompt: string;
  task_type?: string;
  batch: number;
  user_id: number;
  user_name: string;
  model_id?: string;
  force_override_bot_model?: boolean;
}

export interface UpdateTaskRequest {
  title?: string;
  team_id?: number;
  git_url?: string;
  git_repo?: string;
  git_repo_id?: number;
  git_domain?: string;
  branch_name?: string;
  prompt?: string;
  status?: TaskStatus;
  progress?: number;
  batch?: number;
  result?: Record<string, unknown>;
  error_message?: string;
  user_id?: number;
  user_name?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
}

export interface TaskListResponse {
  total: number;
  items: Task[];
}

// Diff related types
export interface BranchDiffRequest {
  git_repo: string;
  source_branch: string;
  target_branch: string;
  type: string;
  git_domain: string;
}

export interface GitDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  previous_filename: string;
  blob_url: string;
  raw_url: string;
  contents_url: string;
}

export interface BranchDiffResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files: GitDiffFile[];
  diff_url: string;
  html_url: string;
  permalink_url: string;
}

// Task Share Types
export interface TaskShareResponse {
  share_url: string;
  share_token: string;
}

export interface TaskShareInfo {
  user_id: number;
  user_name: string;
  task_id: number;
  task_title: string;
  task_type?: string; // 'chat' or 'code'
  git_repo_id?: number; // Original task's repository ID (for code tasks)
  git_repo?: string; // Original task's repository full name (e.g., "owner/repo")
  git_domain?: string; // Original task's git domain (e.g., "github.com")
  git_type?: string; // Original task's git type: "github", "gitlab", "gitee"
  branch_name?: string; // Original task's branch name (for code tasks)
}

export interface JoinSharedTaskRequest {
  share_token: string;
  team_id?: number; // Optional: if not provided, backend will use user's first team
  model_id?: string; // Model name (not database ID)
  force_override_bot_model?: boolean; // Force override bot's predefined model
  // Complete repository information (for code tasks)
  git_repo_id?: number; // Git repository ID
  git_url?: string; // Git repository URL
  git_repo?: string; // Repository full name (e.g., "owner/repo")
  git_domain?: string; // Git domain (e.g., "github.com")
  branch_name?: string; // Git branch name
}

export interface JoinSharedTaskResponse {
  message: string;
  task_id: number; // The copied task ID
}

export interface PublicAttachmentData {
  id: number;
  original_filename: string;
  file_extension: string;
  file_size: number;
  mime_type: string;
  extracted_text: string;
  text_length: number;
  status: string;
}

export interface PublicSubtaskData {
  id: number;
  role: string;
  prompt: string;
  result?: unknown;
  status: string;
  created_at: string;
  updated_at: string;
  attachments: PublicAttachmentData[];
}

export interface PublicSharedTaskResponse {
  task_title: string;
  sharer_name: string;
  sharer_id: number;
  subtasks: PublicSubtaskData[];
  created_at: string;
}

// Task Services

export const taskApis = {
  getTasks: async (
    params?: PaginationParams & { status?: TaskStatus }
  ): Promise<TaskListResponse> => {
    const query = new URLSearchParams();
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.page) query.append('page', params.page.toString());
    if (params?.status) query.append('status', params.status);
    return apiClient.get(`/tasks?${query}`);
  },

  getTasksLite: async (
    params?: PaginationParams & { status?: TaskStatus }
  ): Promise<TaskListResponse> => {
    const query = new URLSearchParams();
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.page) query.append('page', params.page.toString());
    if (params?.status) query.append('status', params.status);
    return apiClient.get(`/tasks/lite?${query}`);
  },

  searchTasks: async (title: string, params?: PaginationParams): Promise<TaskListResponse> => {
    const query = new URLSearchParams();
    query.append('title', title);
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.page) query.append('page', params.page.toString());
    return apiClient.get(`/tasks/search?${query}`);
  },

  // Create task and return its id directly ({ task_id: number } from backend)
  createTask: async (): Promise<number> => {
    const res = await apiClient.post<{ task_id: number }>('/tasks');
    return res.task_id;
  },

  updateTask: async (id: number, data: UpdateTaskRequest): Promise<Task> => {
    return apiClient.put(`/tasks/${id}`, data);
  },

  getTaskDetail: async (id: number): Promise<TaskDetail> => {
    return apiClient.get(`/tasks/${id}`);
  },

  // Send a message. If task_id not provided, create task first, then send.
  sendTaskMessage: async (
    params: { task_id?: number; message: string } & CreateTaskRequest
  ): Promise<{ task_id: number }> => {
    let taskId = params.task_id;

    if (!taskId) {
      // /tasks returns { task_id }, directly get the id; this method no longer fetches the full Task
      const newId = await taskApis.createTask();
      taskId = newId;
    }

    // Send message with related info (reuse CreateTaskRequest fields)
    const { message, ...rest } = params;
    await apiClient.post<SuccessMessage>(`/tasks/${taskId}`, {
      message,
      ...rest,
    });

    // Returns a mock object containing only task_id
    return { task_id: taskId };
  },

  deleteTask: async (id: number): Promise<SuccessMessage> => {
    return apiClient.delete(`/tasks/${id}`);
  },

  // Cancel a running task
  cancelTask: async (id: number): Promise<SuccessMessage> => {
    return apiClient.post(`/tasks/${id}/cancel`, {});
  },

  // Get branch diff
  getBranchDiff: async (params: BranchDiffRequest): Promise<BranchDiffResponse> => {
    const query = new URLSearchParams();
    query.append('git_repo', params.git_repo);
    query.append('source_branch', params.target_branch);
    query.append('target_branch', params.source_branch);
    query.append('type', params.type);
    query.append('git_domain', params.git_domain);
    return apiClient.get(`/git/repositories/diff?${query}`);
  },

  // Share task - generate share link
  shareTask: async (taskId: number): Promise<TaskShareResponse> => {
    return apiClient.post(`/tasks/${taskId}/share`, {});
  },

  // Get task share info - doesn't require authentication
  getTaskShareInfo: async (shareToken: string): Promise<TaskShareInfo> => {
    const query = new URLSearchParams();
    query.append('share_token', shareToken);
    return apiClient.get(`/tasks/share/info?${query}`);
  },

  // Join shared task - copy task to user's task list
  joinSharedTask: async (request: JoinSharedTaskRequest): Promise<JoinSharedTaskResponse> => {
    return apiClient.post('/tasks/share/join', request);
  },

  // Get public shared task - doesn't require authentication
  // Use native fetch to avoid authentication interceptor
  getPublicSharedTask: async (token: string): Promise<PublicSharedTaskResponse> => {
    const query = new URLSearchParams();
    query.append('token', token);
    const response = await fetch(`/api/tasks/share/public?${query}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const json = JSON.parse(errorText);
        if (json && typeof json.detail === 'string') {
          errorMsg = json.detail;
        }
      } catch {
        // Not JSON, use original text
      }
      throw new Error(errorMsg);
    }

    return response.json();
  },

  /**
   * Export task to DOCX format
   */
  exportTaskDocx: async (taskId: number): Promise<Blob> => {
    const token = getToken();
    const response = await fetch(`/api/tasks/${taskId}/export/docx`, {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const json = JSON.parse(errorText);
        if (json && typeof json.detail === 'string') {
          errorMsg = json.detail;
        }
      } catch {
        // Not JSON, use original text
      }
      throw new Error(errorMsg);
    }

    return response.blob();
  },
};
