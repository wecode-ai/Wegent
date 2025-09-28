// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import {
  Task,
  PaginationParams,
  TaskStatus,
  SuccessMessage,
  TaskDetail
} from '../types/api'

// Task Request/Response Types
export interface CreateTaskRequest {
  title: string
  team_id: number
  git_url: string
  git_repo: string
  git_repo_id: number
  git_domain: string
  branch_name: string
  prompt: string
  batch: number
  user_id: number
  user_name: string
}

export interface UpdateTaskRequest {
  title?: string
  team_id?: number
  git_url?: string
  git_repo?: string
  git_repo_id?: number
  git_domain?: string
  branch_name?: string
  prompt?: string
  status?: TaskStatus
  progress?: number
  batch?: number
  result?: Record<string, any>
  error_message?: string
  user_id?: number
  user_name?: string
  created_at?: string
  updated_at?: string
  completed_at?: string
}

export interface TaskListResponse {
  total: number
  items: Task[]
}

// Task Services

export const taskApis = {
  getTasks: async (params?: PaginationParams & { status?: TaskStatus }): Promise<TaskListResponse> => {
    const query = new URLSearchParams()
    if (params?.limit) query.append('limit', params.limit.toString())
    if (params?.page) query.append('page', params.page.toString())
    if (params?.status) query.append('status', params.status)
    return apiClient.get(`/tasks?${query}`)
  },

  searchTasks: async (title: string, params?: PaginationParams): Promise<TaskListResponse> => {
    const query = new URLSearchParams()
    query.append('title', title)
    if (params?.limit) query.append('limit', params.limit.toString())
    if (params?.page) query.append('page', params.page.toString())
    return apiClient.get(`/tasks/search?${query}`)
  },

  // Create task and return its id directly ({ task_id: number } from backend)
  createTask: async (): Promise<number> => {
    const res = await apiClient.post<{ task_id: number }>('/tasks')
    return res.task_id
  },

  updateTask: async (id: number, data: UpdateTaskRequest): Promise<Task> => {
    return apiClient.put(`/tasks/${id}`, data)
  },

  getTask: async (id: number): Promise<Task> => {
    return apiClient.get(`/tasks/${id}`)
  },

  getTaskDetail: async (id: number): Promise<TaskDetail> => {
    return apiClient.get(`/tasks/${id}`)
  },

  // Send a message. If task_id not provided, create task first, then send.
  sendTaskMessage: async (
    params: { task_id?: number; message: string } & CreateTaskRequest
  ): Promise<{ task_id: number }> => {
    let taskId = params.task_id

    if (!taskId) {
      // /tasks 返回 { task_id }，直接拿到 id；本方法不再获取完整 Task
      const newId = await taskApis.createTask()
      taskId = newId
    }

    // Send message with related info (reuse CreateTaskRequest fields)
    const { task_id: _ignored, message, ...rest } = params as any
    await apiClient.post<SuccessMessage>(`/tasks/${taskId}`, {
      message,
      ...rest,
    })

    // 返回 mock 对象，仅包含 task_id
    return { task_id: taskId }
  },
  
  deleteTask: async (id: number): Promise<SuccessMessage> => {
    return apiClient.delete(`/tasks/${id}`)
  }
}