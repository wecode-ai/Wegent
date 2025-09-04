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

  createTask: async (data: CreateTaskRequest): Promise<Task> => {
    return apiClient.post('/tasks', data)
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

  deleteTask: async (id: number): Promise<SuccessMessage> => {
    return apiClient.delete(`/tasks/${id}`)
  }
}