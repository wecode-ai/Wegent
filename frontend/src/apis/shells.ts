// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';

// Shell Types
export type ShellTypeEnum = 'public' | 'user';
export type WorkspaceType = 'ephemeral' | 'persistent';

export interface ShellResources {
  cpu: string; // e.g., "2"
  memory: string; // e.g., "4Gi"
}

export interface UnifiedShell {
  name: string;
  type: ShellTypeEnum; // 'public' or 'user' - identifies shell source
  displayName?: string | null;
  shellType: string; // Agent type: 'ClaudeCode' | 'Agno' | 'Dify'
  baseImage?: string | null;
  baseShellRef?: string | null;
  supportModel?: string[] | null;
  executionType?: 'local_engine' | 'external_api' | null; // Shell execution type
  workspaceType?: WorkspaceType | null; // 'ephemeral' or 'persistent'
  resources?: ShellResources | null; // Resource configuration for persistent containers
}

export interface UnifiedShellListResponse {
  data: UnifiedShell[];
}

export interface ShellCreateRequest {
  name: string;
  displayName?: string;
  baseShellRef: string; // Required: base public shell name (e.g., "ClaudeCode")
  baseImage: string; // Required: custom base image address
  workspaceType?: WorkspaceType; // 'ephemeral' or 'persistent'
  resources?: ShellResources; // Resource configuration
}

export interface ShellUpdateRequest {
  displayName?: string;
  baseImage?: string;
  workspaceType?: WorkspaceType;
  resources?: ShellResources;
}

// Image Validation Types
export interface ImageValidationRequest {
  image: string;
  shellType: string; // e.g., "ClaudeCode", "Agno"
  shellName?: string; // Optional shell name for tracking
}

export interface ImageCheckResult {
  name: string;
  version?: string | null;
  status: 'pass' | 'fail';
  message?: string | null;
}

export interface ImageValidationResponse {
  status: 'submitted' | 'skipped' | 'error';
  message: string;
  validationId?: string | null; // UUID for polling validation status
  validationTaskId?: number | null; // Legacy field
  // For immediate results (e.g., Dify skip)
  valid?: boolean | null;
  checks?: ImageCheckResult[] | null;
  errors?: string[] | null;
}

// Validation Status Types
export type ValidationStage =
  | 'submitted'
  | 'pulling_image'
  | 'starting_container'
  | 'running_checks'
  | 'completed';

export interface ValidationStatusResponse {
  validationId: string;
  status: ValidationStage;
  stage: string; // Human-readable stage description
  progress: number; // 0-100
  valid?: boolean | null;
  checks?: ImageCheckResult[] | null;
  errors?: string[] | null;
  errorMessage?: string | null;
}

// Shell Services
export const shellApis = {
  /**
   * Get unified list of all available shells (both public and user-defined)
   *
   * Each shell includes a 'type' field ('public' or 'user') to identify its source.
   */
  async getUnifiedShells(): Promise<UnifiedShellListResponse> {
    return apiClient.get('/shells/unified');
  },

  /**
   * Get a specific shell by name and optional type
   *
   * @param shellName - Shell name
   * @param shellType - Optional shell type ('public' or 'user')
   */
  async getUnifiedShell(shellName: string, shellType?: ShellTypeEnum): Promise<UnifiedShell> {
    const params = new URLSearchParams();
    if (shellType) {
      params.append('shell_type', shellType);
    }
    const queryString = params.toString();
    return apiClient.get(
      `/shells/unified/${encodeURIComponent(shellName)}${queryString ? `?${queryString}` : ''}`
    );
  },

  /**
   * Create a new user-defined shell
   */
  async createShell(request: ShellCreateRequest): Promise<UnifiedShell> {
    return apiClient.post('/shells', request);
  },

  /**
   * Update an existing user-defined shell
   */
  async updateShell(name: string, request: ShellUpdateRequest): Promise<UnifiedShell> {
    return apiClient.put(`/shells/${encodeURIComponent(name)}`, request);
  },

  /**
   * Delete a user-defined shell
   */
  async deleteShell(name: string): Promise<void> {
    return apiClient.delete(`/shells/${encodeURIComponent(name)}`);
  },

  /**
   * Validate base image compatibility with a shell type
   */
  async validateImage(request: ImageValidationRequest): Promise<ImageValidationResponse> {
    return apiClient.post('/shells/validate-image', request);
  },

  /**
   * Get validation status by validation ID (for polling)
   *
   * @param validationId - UUID of the validation task
   */
  async getValidationStatus(validationId: string): Promise<ValidationStatusResponse> {
    return apiClient.get(`/shells/validation-status/${encodeURIComponent(validationId)}`);
  },

  /**
   * Get public shells only (filter from unified list)
   */
  async getPublicShells(): Promise<UnifiedShell[]> {
    const response = await this.getUnifiedShells();
    return (response.data || []).filter(shell => shell.type === 'public');
  },

  /**
   * Get local_engine type shells only (for base shell selection)
   */
  async getLocalEngineShells(): Promise<UnifiedShell[]> {
    const response = await this.getUnifiedShells();
    return (response.data || []).filter(
      shell => shell.type === 'public' && shell.executionType === 'local_engine'
    );
  },

  /**
   * Get container instance for a shell
   *
   * @param shellName - Shell name
   */
  async getContainerInstance(shellName: string): Promise<ContainerInstanceResponse> {
    return apiClient.get(`/shells/${encodeURIComponent(shellName)}/container`);
  },

  /**
   * Restart container instance for a shell
   *
   * @param shellName - Shell name
   */
  async restartContainer(shellName: string): Promise<{ status: string; message: string }> {
    return apiClient.post(`/shells/${encodeURIComponent(shellName)}/container/restart`);
  },

  /**
   * Delete container instance for a shell
   *
   * @param shellName - Shell name
   */
  async deleteContainer(shellName: string): Promise<{ status: string; message: string }> {
    return apiClient.delete(`/shells/${encodeURIComponent(shellName)}/container`);
  },
};

// Container Instance Types
export type ContainerStatus = 'pending' | 'creating' | 'running' | 'stopped' | 'error';

export interface ContainerInstanceResponse {
  id: number;
  user_id: number;
  shell_id: number;
  container_id?: string | null;
  access_url?: string | null;
  status: ContainerStatus;
  repo_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_task_at?: string | null;
  error_message?: string | null;
}
