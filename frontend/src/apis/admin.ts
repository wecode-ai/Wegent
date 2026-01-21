// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import { RetrieverCRD } from './retrievers'

// Re-export RetrieverCRD for backward compatibility
export type { RetrieverCRD } from './retrievers'

// Admin User Types
export type UserRole = 'admin' | 'user'
export type AuthSource = 'password' | 'oidc' | 'unknown'

export interface AdminUser {
  id: number
  user_name: string
  email: string | null
  role: UserRole
  auth_source: AuthSource
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AdminUserListResponse {
  total: number
  items: AdminUser[]
}

export interface AdminUserCreate {
  user_name: string
  password?: string
  email?: string
  role?: UserRole
  auth_source?: 'password' | 'oidc'
}

export interface AdminUserUpdate {
  user_name?: string
  email?: string
  role?: UserRole
  is_active?: boolean
}

export interface PasswordResetRequest {
  new_password: string
}

export interface RoleUpdateRequest {
  role: UserRole
}

// Public Model Types
export interface AdminPublicModel {
  id: number
  name: string
  namespace: string
  display_name: string | null
  json: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AdminPublicModelListResponse {
  total: number
  items: AdminPublicModel[]
}

export interface AdminPublicModelCreate {
  name: string
  namespace?: string
  json: Record<string, unknown>
}

export interface AdminPublicModelUpdate {
  name?: string
  namespace?: string
  json?: Record<string, unknown>
  is_active?: boolean
}

// System Stats Types
export interface SystemStats {
  total_users: number
  active_users: number
  admin_count: number
  total_tasks: number
  total_public_models: number
}

// Chat Slogan & Tips Types
export type SloganTipMode = 'chat' | 'code' | 'both'

export interface ChatSloganItem {
  id: number
  zh: string
  en: string
  mode?: SloganTipMode
}

export interface ChatTipItem {
  id: number
  zh: string
  en: string
  mode?: SloganTipMode
}

export interface ChatSloganTipsUpdate {
  slogans: ChatSloganItem[]
  tips: ChatTipItem[]
}

export interface ChatSloganTipsResponse {
  version: number
  slogans: ChatSloganItem[]
  tips: ChatTipItem[]
}

// Service Key Types
export interface ServiceKey {
  id: number
  name: string
  key_prefix: string
  description: string | null
  expires_at: string
  last_used_at: string
  created_at: string
  is_active: boolean
  created_by: string | null
}

export interface ServiceKeyCreated extends ServiceKey {
  key: string // Full key, only at creation
}

export interface ServiceKeyCreateRequest {
  name: string
  description?: string
}

export interface ServiceKeyListResponse {
  items: ServiceKey[]
  total: number
}

// Personal Key Types (Admin Management)
export interface AdminPersonalKey {
  id: number
  user_id: number
  user_name: string
  name: string
  key_prefix: string
  description: string | null
  expires_at: string
  last_used_at: string
  created_at: string
  is_active: boolean
}

export interface AdminPersonalKeyListResponse {
  items: AdminPersonalKey[]
  total: number
}
// Background Execution Monitor Types
export interface BackgroundExecutionMonitorStats {
  total_executions: number
  completed_count: number
  failed_count: number
  timeout_count: number
  cancelled_count: number
  running_count: number
  pending_count: number
  success_rate: number
  failure_rate: number
  timeout_rate: number
  active_subscriptions_count: number
  total_subscriptions_count: number
}

export interface BackgroundExecutionMonitorError {
  execution_id: number
  subscription_id: number
  user_id: number
  task_id: number | null
  status: string
  error_message: string | null
  trigger_type: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface BackgroundExecutionMonitorErrorListResponse {
  total: number
  items: BackgroundExecutionMonitorError[]
}

// Public Retriever Types
export interface AdminPublicRetriever {
  id: number
  name: string
  namespace: string
  displayName: string | null
  storageType: string
  description: string | null
  json: RetrieverCRD
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AdminPublicRetrieverListResponse {
  total: number
  items: AdminPublicRetriever[]
}

// Public Team Types
export interface AdminPublicTeam {
  id: number
  name: string
  namespace: string
  display_name: string | null
  description: string | null
  json: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AdminPublicTeamListResponse {
  total: number
  items: AdminPublicTeam[]
}

export interface AdminPublicTeamCreate {
  name: string
  namespace?: string
  json: Record<string, unknown>
}

export interface AdminPublicTeamUpdate {
  name?: string
  namespace?: string
  json?: Record<string, unknown>
  is_active?: boolean
}

// Public Bot Types
export interface AdminPublicBot {
  id: number
  name: string
  namespace: string
  display_name: string | null
  json: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
  ghost_name: string | null
  shell_name: string | null
  model_name: string | null
}

export interface AdminPublicBotListResponse {
  total: number
  items: AdminPublicBot[]
}

export interface AdminPublicBotCreate {
  name: string
  namespace?: string
  json: Record<string, unknown>
}

export interface AdminPublicBotUpdate {
  name?: string
  namespace?: string
  json?: Record<string, unknown>
  is_active?: boolean
}

// Public Ghost Types
export interface AdminPublicGhost {
  id: number
  name: string
  namespace: string
  display_name: string | null
  description: string | null
  json: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AdminPublicGhostListResponse {
  total: number
  items: AdminPublicGhost[]
}

export interface AdminPublicGhostCreate {
  name: string
  namespace?: string
  json: Record<string, unknown>
}

export interface AdminPublicGhostUpdate {
  name?: string
  namespace?: string
  json?: Record<string, unknown>
  is_active?: boolean
}

// Public Shell Types
export interface AdminPublicShell {
  id: number
  name: string
  namespace: string
  display_name: string | null
  shell_type: string | null
  json: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AdminPublicShellListResponse {
  total: number
  items: AdminPublicShell[]
}

export interface AdminPublicShellCreate {
  name: string
  namespace?: string
  json: Record<string, unknown>
}

export interface AdminPublicShellUpdate {
  name?: string
  namespace?: string
  json?: Record<string, unknown>
  is_active?: boolean
}

// Admin API Services
export const adminApis = {
  // ==================== User Management ====================

  /**
   * Get list of all users with pagination and search
   */
  async getUsers(
    page: number = 1,
    limit: number = 20,
    includeInactive: boolean = false,
    search?: string
  ): Promise<AdminUserListResponse> {
    const params = new URLSearchParams()
    params.append('page', String(page))
    params.append('limit', String(limit))
    if (includeInactive) {
      params.append('include_inactive', 'true')
    }
    if (search) {
      params.append('search', search)
    }
    return apiClient.get(`/admin/users?${params.toString()}`)
  },

  /**
   * Get user by ID
   */
  async getUserById(userId: number): Promise<AdminUser> {
    return apiClient.get(`/admin/users/${userId}`)
  },

  /**
   * Create a new user
   */
  async createUser(userData: AdminUserCreate): Promise<AdminUser> {
    return apiClient.post('/admin/users', userData)
  },

  /**
   * Update user information
   */
  async updateUser(userId: number, userData: AdminUserUpdate): Promise<AdminUser> {
    return apiClient.put(`/admin/users/${userId}`, userData)
  },

  /**
   * Delete a user (soft delete)
   */
  async deleteUser(userId: number): Promise<void> {
    return apiClient.delete(`/admin/users/${userId}`)
  },

  /**
   * Reset user password
   */
  async resetPassword(userId: number, data: PasswordResetRequest): Promise<AdminUser> {
    return apiClient.post(`/admin/users/${userId}/reset-password`, data)
  },

  /**
   * Toggle user active status
   */
  async toggleUserStatus(userId: number): Promise<AdminUser> {
    return apiClient.post(`/admin/users/${userId}/toggle-status`)
  },

  /**
   * Update user role
   */
  async updateUserRole(userId: number, data: RoleUpdateRequest): Promise<AdminUser> {
    return apiClient.put(`/admin/users/${userId}/role`, data)
  },

  // ==================== Public Model Management ====================

  /**
   * Get list of all public models with pagination
   */
  async getPublicModels(
    page: number = 1,
    limit: number = 20
  ): Promise<AdminPublicModelListResponse> {
    return apiClient.get(`/admin/public-models?page=${page}&limit=${limit}`)
  },

  /**
   * Create a new public model
   */
  async createPublicModel(modelData: AdminPublicModelCreate): Promise<AdminPublicModel> {
    return apiClient.post('/admin/public-models', modelData)
  },

  /**
   * Update a public model
   */
  async updatePublicModel(
    modelId: number,
    modelData: AdminPublicModelUpdate
  ): Promise<AdminPublicModel> {
    return apiClient.put(`/admin/public-models/${modelId}`, modelData)
  },

  /**
   * Delete a public model
   */
  async deletePublicModel(modelId: number): Promise<void> {
    return apiClient.delete(`/admin/public-models/${modelId}`)
  },

  // ==================== System Stats ====================

  /**
   * Get system statistics
   */
  async getSystemStats(): Promise<SystemStats> {
    return apiClient.get('/admin/stats')
  },

  // ==================== System Config (Quick Access) ====================

  /**
   * Get system recommended quick access configuration
   */
  async getQuickAccessConfig(): Promise<{ version: number; teams: number[] }> {
    return apiClient.get('/admin/system-config/quick-access')
  },

  /**
   * Update system recommended quick access configuration
   */
  async updateQuickAccessConfig(teams: number[]): Promise<{ version: number; teams: number[] }> {
    return apiClient.put('/admin/system-config/quick-access', { teams })
  },

  // ==================== Chat Slogan & Tips Config ====================

  /**
   * Get chat slogan and tips configuration
   */
  async getSloganTipsConfig(): Promise<ChatSloganTipsResponse> {
    return apiClient.get('/admin/system-config/slogan-tips')
  },

  /**
   * Update chat slogan and tips configuration
   */
  async updateSloganTipsConfig(data: ChatSloganTipsUpdate): Promise<ChatSloganTipsResponse> {
    return apiClient.put('/admin/system-config/slogan-tips', data)
  },

  // ==================== Service Key Management ====================

  /**
   * Get list of all service keys
   */
  async getServiceKeys(): Promise<ServiceKeyListResponse> {
    return apiClient.get('/admin/service-keys')
  },

  /**
   * Create a new service key
   * The full key is only returned at creation time
   */
  async createServiceKey(data: ServiceKeyCreateRequest): Promise<ServiceKeyCreated> {
    return apiClient.post('/admin/service-keys', data)
  },

  /**
   * Toggle service key active status
   */
  async toggleServiceKeyStatus(keyId: number): Promise<ServiceKey> {
    return apiClient.post(`/admin/service-keys/${keyId}/toggle-status`)
  },

  /**
   * Delete a service key
   */
  async deleteServiceKey(keyId: number): Promise<void> {
    return apiClient.delete(`/admin/service-keys/${keyId}`)
  },

  // ==================== Personal Key Management (Admin) ====================

  /**
   * Get list of all personal keys with their owners
   */
  async getPersonalKeys(
    page: number = 1,
    limit: number = 50,
    search?: string
  ): Promise<AdminPersonalKeyListResponse> {
    const params = new URLSearchParams()
    params.append('page', String(page))
    params.append('limit', String(limit))
    if (search) {
      params.append('search', search)
    }
    return apiClient.get(`/admin/personal-keys?${params.toString()}`)
  },

  /**
   * Toggle personal key active status
   */
  async togglePersonalKeyStatus(keyId: number): Promise<AdminPersonalKey> {
    return apiClient.post(`/admin/personal-keys/${keyId}/toggle-status`)
  },

  /**
   * Delete a personal key
   */
  async deletePersonalKey(keyId: number): Promise<void> {
    return apiClient.delete(`/admin/personal-keys/${keyId}`)
  },

  // ==================== Public Retriever Management ====================

  /**
   * Get list of all public retrievers with pagination
   */
  async getPublicRetrievers(
    page: number = 1,
    limit: number = 20
  ): Promise<AdminPublicRetrieverListResponse> {
    return apiClient.get(`/admin/public-retrievers?page=${page}&limit=${limit}`)
  },

  /**
   * Create a new public retriever
   */
  async createPublicRetriever(retrieverData: RetrieverCRD): Promise<AdminPublicRetriever> {
    return apiClient.post('/admin/public-retrievers', retrieverData)
  },

  /**
   * Update a public retriever
   */
  async updatePublicRetriever(
    retrieverId: number,
    retrieverData: RetrieverCRD
  ): Promise<AdminPublicRetriever> {
    return apiClient.put(`/admin/public-retrievers/${retrieverId}`, retrieverData)
  },

  /**
   * Delete a public retriever
   */
  async deletePublicRetriever(retrieverId: number): Promise<void> {
    return apiClient.delete(`/admin/public-retrievers/${retrieverId}`)
  },

  // ==================== Background Execution Monitor ====================

  /**
   * Get background execution statistics for admin monitoring
   */
  async getBackgroundExecutionMonitorStats(
    hours: number = 24
  ): Promise<BackgroundExecutionMonitorStats> {
    return apiClient.get(`/admin/subscription-monitor/stats?hours=${hours}`)
  },

  /**
   * Get list of background execution errors for admin monitoring
   */
  async getBackgroundExecutionMonitorErrors(
    page: number = 1,
    limit: number = 50,
    hours: number = 24,
    status?: string
  ): Promise<BackgroundExecutionMonitorErrorListResponse> {
    const params = new URLSearchParams()
    params.append('page', String(page))
    params.append('limit', String(limit))
    params.append('hours', String(hours))
    if (status) {
      params.append('status', status)
    }
    return apiClient.get(`/admin/subscription-monitor/errors?${params.toString()}`)
  },

  // ==================== Public Team Management ====================

  /**
   * Get list of all public teams with pagination
   */
  async getPublicTeams(page: number = 1, limit: number = 20): Promise<AdminPublicTeamListResponse> {
    return apiClient.get(`/admin/public-teams?page=${page}&limit=${limit}`)
  },

  /**
   * Create a new public team
   */
  async createPublicTeam(teamData: AdminPublicTeamCreate): Promise<AdminPublicTeam> {
    return apiClient.post('/admin/public-teams', teamData)
  },

  /**
   * Update a public team
   */
  async updatePublicTeam(
    teamId: number,
    teamData: AdminPublicTeamUpdate
  ): Promise<AdminPublicTeam> {
    return apiClient.put(`/admin/public-teams/${teamId}`, teamData)
  },

  /**
   * Delete a public team
   */
  async deletePublicTeam(teamId: number): Promise<void> {
    return apiClient.delete(`/admin/public-teams/${teamId}`)
  },

  // ==================== Public Bot Management ====================

  /**
   * Get list of all public bots with pagination
   */
  async getPublicBots(page: number = 1, limit: number = 20): Promise<AdminPublicBotListResponse> {
    return apiClient.get(`/admin/public-bots?page=${page}&limit=${limit}`)
  },

  /**
   * Create a new public bot
   */
  async createPublicBot(botData: AdminPublicBotCreate): Promise<AdminPublicBot> {
    return apiClient.post('/admin/public-bots', botData)
  },

  /**
   * Update a public bot
   */
  async updatePublicBot(botId: number, botData: AdminPublicBotUpdate): Promise<AdminPublicBot> {
    return apiClient.put(`/admin/public-bots/${botId}`, botData)
  },

  /**
   * Delete a public bot
   */
  async deletePublicBot(botId: number): Promise<void> {
    return apiClient.delete(`/admin/public-bots/${botId}`)
  },

  // ==================== Public Ghost Management ====================

  /**
   * Get list of all public ghosts with pagination
   */
  async getPublicGhosts(
    page: number = 1,
    limit: number = 20
  ): Promise<AdminPublicGhostListResponse> {
    return apiClient.get(`/admin/public-ghosts?page=${page}&limit=${limit}`)
  },

  /**
   * Create a new public ghost
   */
  async createPublicGhost(ghostData: AdminPublicGhostCreate): Promise<AdminPublicGhost> {
    return apiClient.post('/admin/public-ghosts', ghostData)
  },

  /**
   * Update a public ghost
   */
  async updatePublicGhost(
    ghostId: number,
    ghostData: AdminPublicGhostUpdate
  ): Promise<AdminPublicGhost> {
    return apiClient.put(`/admin/public-ghosts/${ghostId}`, ghostData)
  },

  /**
   * Delete a public ghost
   */
  async deletePublicGhost(ghostId: number): Promise<void> {
    return apiClient.delete(`/admin/public-ghosts/${ghostId}`)
  },

  // ==================== Public Shell Management ====================

  /**
   * Get list of all public shells with pagination
   */
  async getPublicShells(
    page: number = 1,
    limit: number = 20
  ): Promise<AdminPublicShellListResponse> {
    return apiClient.get(`/admin/public-shells?page=${page}&limit=${limit}`)
  },

  /**
   * Create a new public shell
   */
  async createPublicShell(shellData: AdminPublicShellCreate): Promise<AdminPublicShell> {
    return apiClient.post('/admin/public-shells', shellData)
  },

  /**
   * Update a public shell
   */
  async updatePublicShell(
    shellId: number,
    shellData: AdminPublicShellUpdate
  ): Promise<AdminPublicShell> {
    return apiClient.put(`/admin/public-shells/${shellId}`, shellData)
  },

  /**
   * Delete a public shell
   */
  async deletePublicShell(shellId: number): Promise<void> {
    return apiClient.delete(`/admin/public-shells/${shellId}`)
  },
}
