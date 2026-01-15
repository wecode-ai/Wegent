// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import {
  Project,
  ProjectListResponse,
  ProjectTask,
  ProjectWithTasks,
  SuccessMessage,
} from '../types/api'

// Project Request Types
export interface CreateProjectRequest {
  name: string
  description?: string
  color?: string
}

export interface UpdateProjectRequest {
  name?: string
  description?: string
  color?: string
  sort_order?: number
  is_expanded?: boolean
}

export interface AddTaskToProjectRequest {
  task_id: number
}

export interface AddTaskToProjectResponse {
  message: string
  project_task: ProjectTask
}

export interface RemoveTaskFromProjectResponse {
  message: string
}

// Project API Services
export const projectApis = {
  /**
   * Get all projects for the current user
   * @param includeTasks - Whether to include tasks in the response
   */
  getProjects: async (includeTasks: boolean = true): Promise<ProjectListResponse> => {
    const query = new URLSearchParams()
    query.append('include_tasks', includeTasks.toString())
    return apiClient.get(`/projects?${query}`)
  },

  /**
   * Get a single project by ID with its tasks
   * @param projectId - Project ID
   */
  getProject: async (projectId: number): Promise<ProjectWithTasks> => {
    return apiClient.get(`/projects/${projectId}`)
  },

  /**
   * Create a new project
   * @param data - Project creation data
   */
  createProject: async (data: CreateProjectRequest): Promise<Project> => {
    return apiClient.post('/projects', data)
  },

  /**
   * Update a project
   * @param projectId - Project ID
   * @param data - Update data
   */
  updateProject: async (projectId: number, data: UpdateProjectRequest): Promise<Project> => {
    return apiClient.put(`/projects/${projectId}`, data)
  },

  /**
   * Delete a project (soft delete)
   * @param projectId - Project ID
   */
  deleteProject: async (projectId: number): Promise<SuccessMessage> => {
    return apiClient.delete(`/projects/${projectId}`)
  },

  /**
   * Add a task to a project
   * @param projectId - Project ID
   * @param taskId - Task ID to add
   */
  addTaskToProject: async (
    projectId: number,
    taskId: number
  ): Promise<AddTaskToProjectResponse> => {
    return apiClient.post(`/projects/${projectId}/tasks`, { task_id: taskId })
  },

  /**
   * Remove a task from a project
   * @param projectId - Project ID
   * @param taskId - Task ID to remove
   */
  removeTaskFromProject: async (
    projectId: number,
    taskId: number
  ): Promise<RemoveTaskFromProjectResponse> => {
    return apiClient.delete(`/projects/${projectId}/tasks/${taskId}`)
  },
}
