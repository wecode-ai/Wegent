// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Shell Types
export type ShellTypeEnum = 'public' | 'user' | 'group'

export interface UnifiedShell {
  name: string
  type: ShellTypeEnum // 'public', 'user', or 'group' - identifies shell source
  displayName?: string | null
  shellType: string // Agent type: 'ClaudeCode' | 'Agno' | 'Dify'
  baseImage?: string | null
  baseShellRef?: string | null
  supportModel?: string[] | null
  executionType?: 'local_engine' | 'external_api' | null // Shell execution type
  namespace?: string // Resource namespace (group name or 'default')
}

export interface UnifiedShellListResponse {
  data: UnifiedShell[]
}

export interface ShellCreateRequest {
  name: string
  displayName?: string
  baseShellRef: string // Required: base public shell name (e.g., "ClaudeCode")
  baseImage: string // Required: custom base image address
}

export interface ShellUpdateRequest {
  displayName?: string
  baseImage?: string
}

// Image Validation Types
export interface ImageValidationRequest {
  image: string
  shellType: string // e.g., "ClaudeCode", "Agno"
  shellName?: string // Optional shell name for tracking
}

export interface ImageCheckResult {
  name: string
  version?: string | null
  status: 'pass' | 'fail'
  message?: string | null
}

export interface ImageValidationResponse {
  status: 'submitted' | 'skipped' | 'error'
  message: string
  validationId?: string | null // UUID for polling validation status
  validationTaskId?: number | null // Legacy field
  // For immediate results (e.g., Dify skip)
  valid?: boolean | null
  checks?: ImageCheckResult[] | null
  errors?: string[] | null
}

// Validation Status Types
export type ValidationStage =
  | 'submitted'
  | 'pulling_image'
  | 'starting_container'
  | 'running_checks'
  | 'completed'

export interface ValidationStatusResponse {
  validationId: string
  status: ValidationStage
  stage: string // Human-readable stage description
  progress: number // 0-100
  valid?: boolean | null
  checks?: ImageCheckResult[] | null
  errors?: string[] | null
  errorMessage?: string | null
}

// Shell Services
export const shellApis = {
  /**
   * Get unified list of all available shells (public, user-defined, and group shells)
   *
   * Each shell includes a 'type' field ('public', 'user', or 'group') to identify its source.
   * @param scope - Resource scope: 'personal', 'group', or 'all'
   * @param groupName - Group name (required when scope is 'group')
   */
  async getUnifiedShells(
    scope?: 'personal' | 'group' | 'all',
    groupName?: string
  ): Promise<UnifiedShellListResponse> {
    const params = new URLSearchParams()
    if (scope) {
      params.append('scope', scope)
    }
    if (groupName) {
      params.append('group_name', groupName)
    }
    const queryString = params.toString()
    return apiClient.get(`/shells/unified${queryString ? `?${queryString}` : ''}`)
  },

  /**
   * Get a specific shell by name and optional type
   *
   * @param shellName - Shell name
   * @param shellType - Optional shell type ('public' or 'user')
   */
  async getUnifiedShell(shellName: string, shellType?: ShellTypeEnum): Promise<UnifiedShell> {
    const params = new URLSearchParams()
    if (shellType) {
      params.append('shell_type', shellType)
    }
    const queryString = params.toString()
    return apiClient.get(
      `/shells/unified/${encodeURIComponent(shellName)}${queryString ? `?${queryString}` : ''}`
    )
  },

  /**
   * Create a new user-defined shell
   * @param request - Shell creation data
   * @param groupName - Optional group name to create shell in group scope
   */
  async createShell(request: ShellCreateRequest, groupName?: string): Promise<UnifiedShell> {
    const params = new URLSearchParams()
    if (groupName) {
      params.append('group_name', groupName)
    }
    const queryString = params.toString()
    return apiClient.post(`/shells${queryString ? `?${queryString}` : ''}`, request)
  },

  /**
   * Update an existing user-defined shell
   */
  async updateShell(name: string, request: ShellUpdateRequest): Promise<UnifiedShell> {
    return apiClient.put(`/shells/${encodeURIComponent(name)}`, request)
  },

  /**
   * Delete a user-defined shell
   */
  async deleteShell(name: string): Promise<void> {
    return apiClient.delete(`/shells/${encodeURIComponent(name)}`)
  },

  /**
   * Validate base image compatibility with a shell type
   */
  async validateImage(request: ImageValidationRequest): Promise<ImageValidationResponse> {
    return apiClient.post('/shells/validate-image', request)
  },

  /**
   * Get validation status by validation ID (for polling)
   *
   * @param validationId - UUID of the validation task
   */
  async getValidationStatus(validationId: string): Promise<ValidationStatusResponse> {
    return apiClient.get(`/shells/validation-status/${encodeURIComponent(validationId)}`)
  },

  /**
   * Get public shells only (filter from unified list)
   */
  async getPublicShells(): Promise<UnifiedShell[]> {
    const response = await this.getUnifiedShells()
    return (response.data || []).filter(shell => shell.type === 'public')
  },

  /**
   * Get local_engine type shells only (for base shell selection)
   */
  async getLocalEngineShells(): Promise<UnifiedShell[]> {
    const response = await this.getUnifiedShells()
    return (response.data || []).filter(
      shell => shell.type === 'public' && shell.executionType === 'local_engine'
    )
  },
}
