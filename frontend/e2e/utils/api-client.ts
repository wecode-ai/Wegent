import { APIRequestContext, APIResponse } from '@playwright/test'

/**
 * API response wrapper type
 */
export interface ApiResponse<T = unknown> {
  status: number
  data: T | null
  headers: Record<string, string>
}

/**
 * API client for E2E tests
 * Provides typed methods for backend API calls
 */
export class ApiClient {
  constructor(
    private request: APIRequestContext,
    private baseURL: string,
    private token?: string
  ) {}

  /**
   * Set authentication token
   */
  setToken(token: string): void {
    this.token = token
  }

  /**
   * Clear authentication token
   */
  clearToken(): void {
    this.token = undefined
  }

  /**
   * Internal method to make API calls
   */
  private async call<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    endpoint: string,
    data?: unknown,
    timeout?: number
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    let response: APIResponse

    const options = {
      headers,
      ...(data ? { data } : {}),
      ...(timeout ? { timeout } : {}),
    }

    const url = `${this.baseURL}${endpoint}`

    switch (method) {
      case 'GET':
        response = await this.request.get(url, options)
        break
      case 'POST':
        response = await this.request.post(url, options)
        break
      case 'PUT':
        response = await this.request.put(url, options)
        break
      case 'DELETE':
        response = await this.request.delete(url, options)
        break
      case 'PATCH':
        response = await this.request.patch(url, options)
        break
    }

    return {
      status: response.status(),
      data: await response.json().catch(() => null),
      headers: response.headers(),
    }
  }

  // ==================== Auth APIs ====================

  /**
   * Login to the application with retry logic for CI stability
   */
  async login(
    username: string,
    password: string,
    maxRetries: number = 3
  ): Promise<ApiResponse<{ access_token: string; token_type: string }>> {
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.call<{ access_token: string; token_type: string }>(
          'POST',
          '/api/auth/login',
          {
            user_name: username,
            password,
          },
          30000 // 30 second timeout for login
        )
        if (response.data?.access_token) {
          this.setToken(response.data.access_token)
        }
        return response
      } catch (error) {
        lastError = error as Error
        if (attempt < maxRetries) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
        }
      }
    }

    // If all retries failed, throw the last error
    throw lastError
  }

  /**
   * Get current user info
   */
  async getCurrentUser(): Promise<ApiResponse> {
    return this.call('GET', '/api/users/me')
  }

  // ==================== Bot APIs ====================

  /**
   * Create a new bot
   */
  async createBot(botData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/bots', botData)
  }

  /**
   * Get list of bots
   */
  async getBots(scope?: 'personal' | 'group' | 'all', groupName?: string): Promise<ApiResponse> {
    const params = new URLSearchParams()
    if (scope) params.append('scope', scope)
    if (groupName) params.append('group_name', groupName)
    const query = params.toString() ? `?${params}` : ''
    return this.call('GET', `/api/bots${query}`)
  }

  /**
   * Get a specific bot by name
   */
  async getBot(name: string, namespace: string = 'default'): Promise<ApiResponse> {
    return this.call('GET', `/api/v1/namespaces/${namespace}/bots/${name}`)
  }

  /**
   * Update a bot
   */
  async updateBot(
    name: string,
    namespace: string = 'default',
    data: unknown
  ): Promise<ApiResponse> {
    return this.call('PUT', `/api/v1/namespaces/${namespace}/bots/${name}`, data)
  }

  /**
   * Delete a bot
   */
  async deleteBot(name: string, namespace: string = 'default'): Promise<ApiResponse> {
    return this.call('DELETE', `/api/v1/namespaces/${namespace}/bots/${name}`)
  }

  // ==================== Model APIs ====================

  /**
   * Create a new model
   */
  async createModel(modelData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/models', modelData)
  }

  /**
   * Get list of models (unified)
   */
  async getModels(): Promise<ApiResponse> {
    return this.call('GET', '/api/models/unified')
  }

  /**
   * Get a specific model by name
   */
  async getModel(name: string): Promise<ApiResponse> {
    return this.call('GET', `/api/models/unified/${name}`)
  }

  /**
   * Test model connection
   */
  async testModelConnection(modelData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/models/test-connection', modelData)
  }

  /**
   * Get compatible models for an agent
   */
  async getCompatibleModels(agentName: string): Promise<ApiResponse> {
    return this.call('GET', `/api/models/compatible?agent_name=${agentName}`)
  }

  /**
   * Delete a model
   */
  async deleteModel(name: string): Promise<ApiResponse> {
    return this.call('DELETE', `/api/models/${name}`)
  }

  // ==================== Team APIs ====================

  /**
   * Create a new team
   */
  async createTeam(teamData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/teams', teamData)
  }

  /**
   * Get list of teams
   */
  async getTeams(scope?: 'personal' | 'group' | 'all', groupName?: string): Promise<ApiResponse> {
    const params = new URLSearchParams()
    if (scope) params.append('scope', scope)
    if (groupName) params.append('group_name', groupName)
    const query = params.toString() ? `?${params}` : ''
    return this.call('GET', `/api/teams${query}`)
  }

  /**
   * Get a specific team by name
   */
  async getTeam(name: string, namespace: string = 'default'): Promise<ApiResponse> {
    return this.call('GET', `/api/v1/namespaces/${namespace}/teams/${name}`)
  }

  /**
   * Update a team
   */
  async updateTeam(
    name: string,
    namespace: string = 'default',
    data: unknown
  ): Promise<ApiResponse> {
    return this.call('PUT', `/api/v1/namespaces/${namespace}/teams/${name}`, data)
  }

  /**
   * Delete a team
   */
  async deleteTeam(name: string, namespace: string = 'default'): Promise<ApiResponse> {
    return this.call('DELETE', `/api/v1/namespaces/${namespace}/teams/${name}`)
  }

  // ==================== Group APIs ====================

  /**
   * Create a new group
   */
  async createGroup(groupData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/groups', groupData)
  }

  /**
   * Get list of groups
   */
  async getGroups(): Promise<ApiResponse> {
    return this.call('GET', '/api/groups')
  }

  /**
   * Get a specific group by name
   */
  async getGroup(groupName: string): Promise<ApiResponse> {
    return this.call('GET', `/api/groups/${groupName}`)
  }

  /**
   * Update a group
   */
  async updateGroup(groupName: string, data: unknown): Promise<ApiResponse> {
    return this.call('PUT', `/api/groups/${groupName}`, data)
  }

  /**
   * Delete a group
   */
  async deleteGroup(groupName: string): Promise<ApiResponse> {
    return this.call('DELETE', `/api/groups/${groupName}`)
  }

  /**
   * Get group members
   */
  async getGroupMembers(groupName: string): Promise<ApiResponse> {
    return this.call('GET', `/api/groups/${groupName}/members`)
  }

  /**
   * Add member to group
   */
  async addGroupMember(groupName: string, memberData: unknown): Promise<ApiResponse> {
    return this.call('POST', `/api/groups/${groupName}/members`, memberData)
  }

  /**
   * Update group member
   */
  async updateGroupMember(
    groupName: string,
    memberId: number,
    data: unknown
  ): Promise<ApiResponse> {
    return this.call('PUT', `/api/groups/${groupName}/members/${memberId}`, data)
  }

  /**
   * Remove member from group
   */
  async removeGroupMember(groupName: string, memberId: number): Promise<ApiResponse> {
    return this.call('DELETE', `/api/groups/${groupName}/members/${memberId}`)
  }

  /**
   * Get user permissions in group
   */
  async getGroupPermissions(groupName: string): Promise<ApiResponse> {
    return this.call('GET', `/api/groups/${groupName}/permissions`)
  }

  // ==================== Task APIs ====================

  /**
   * Create a new task
   */
  async createTask(taskData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/tasks', taskData)
  }

  /**
   * Get list of tasks
   */
  async getTasks(page: number = 1, pageSize: number = 20): Promise<ApiResponse> {
    return this.call('GET', `/api/tasks?page=${page}&page_size=${pageSize}`)
  }

  /**
   * Get a specific task by ID
   */
  async getTask(taskId: string): Promise<ApiResponse> {
    return this.call('GET', `/api/tasks/${taskId}`)
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<ApiResponse> {
    return this.call('POST', `/api/tasks/${taskId}/cancel`)
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<ApiResponse> {
    return this.call('DELETE', `/api/tasks/${taskId}`)
  }

  // ==================== Shell APIs ====================

  /**
   * Get list of shells (unified)
   */
  async getShells(): Promise<ApiResponse> {
    return this.call('GET', '/api/shells/unified')
  }

  /**
   * Get a specific shell by name
   */
  async getShell(name: string, namespace: string = 'default'): Promise<ApiResponse> {
    return this.call('GET', `/api/v1/namespaces/${namespace}/shells/${name}`)
  }

  /**
   * Validate shell image
   */
  async validateShellImage(image: string): Promise<ApiResponse> {
    return this.call('POST', '/api/shells/validate-image', { image })
  }

  // ==================== Admin APIs ====================

  /**
   * List all users (admin only)
   */
  async adminListUsers(page: number = 1, pageSize: number = 20): Promise<ApiResponse> {
    return this.call('GET', `/api/admin/users?page=${page}&page_size=${pageSize}`)
  }

  /**
   * Create a new user (admin only)
   */
  async adminCreateUser(userData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/admin/users', userData)
  }

  /**
   * Get user details (admin only)
   */
  async adminGetUser(userId: number): Promise<ApiResponse> {
    return this.call('GET', `/api/admin/users/${userId}`)
  }

  /**
   * Update user (admin only)
   */
  async adminUpdateUser(userId: number, data: unknown): Promise<ApiResponse> {
    return this.call('PUT', `/api/admin/users/${userId}`, data)
  }

  /**
   * Delete user (admin only)
   */
  async adminDeleteUser(userId: number): Promise<ApiResponse> {
    return this.call('DELETE', `/api/admin/users/${userId}`)
  }

  /**
   * Reset user password (admin only)
   */
  async adminResetpassword(userId: number): Promise<ApiResponse> {
    return this.call('POST', `/api/admin/users/${userId}/reset-password`)
  }

  /**
   * Toggle user status (admin only)
   */
  async adminToggleUserStatus(userId: number): Promise<ApiResponse> {
    return this.call('POST', `/api/admin/users/${userId}/toggle-status`)
  }

  /**
   * Update user role (admin only)
   */
  async adminUpdateUserRole(userId: number, role: string): Promise<ApiResponse> {
    return this.call('PUT', `/api/admin/users/${userId}/role`, { role })
  }

  /**
   * Get system stats (admin only)
   */
  async adminGetStats(): Promise<ApiResponse> {
    return this.call('GET', '/api/admin/stats')
  }

  /**
   * List public models (admin only)
   */
  async adminListPublicModels(): Promise<ApiResponse> {
    return this.call('GET', '/api/admin/public-models')
  }

  /**
   * Create public model (admin only)
   */
  async adminCreatePublicModel(modelData: unknown): Promise<ApiResponse> {
    return this.call('POST', '/api/admin/public-models', modelData)
  }

  /**
   * Update public model (admin only)
   */
  async adminUpdatePublicModel(modelId: number, data: unknown): Promise<ApiResponse> {
    return this.call('PUT', `/api/admin/public-models/${modelId}`, data)
  }

  /**
   * Delete public model (admin only)
   */
  async adminDeletePublicModel(modelId: number): Promise<ApiResponse> {
    return this.call('DELETE', `/api/admin/public-models/${modelId}`)
  }

  // ==================== Utility Methods ====================

  /**
   * Health check
   */
  async healthCheck(): Promise<ApiResponse> {
    return this.call('GET', '/api/health')
  }

  /**
   * Generic GET request
   */
  async get<T = unknown>(endpoint: string): Promise<ApiResponse<T>> {
    return this.call<T>('GET', endpoint)
  }

  /**
   * Generic POST request
   */
  async post<T = unknown>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.call<T>('POST', endpoint, data)
  }

  /**
   * Generic PUT request
   */
  async put<T = unknown>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.call<T>('PUT', endpoint, data)
  }

  /**
   * Generic DELETE request
   */
  async delete<T = unknown>(endpoint: string): Promise<ApiResponse<T>> {
    return this.call<T>('DELETE', endpoint)
  }
}

/**
 * Create an API client instance
 */
export function createApiClient(
  request: APIRequestContext,
  baseURL?: string,
  token?: string
): ApiClient {
  const url = baseURL || process.env.E2E_API_URL || 'http://localhost:8000'
  return new ApiClient(request, url, token)
}
