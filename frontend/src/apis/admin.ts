// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';

// Admin User Types
export type UserRole = 'admin' | 'user';
export type AuthSource = 'password' | 'oidc' | 'unknown';

export interface AdminUser {
  id: number;
  user_name: string;
  email: string | null;
  role: UserRole;
  auth_source: AuthSource;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUserListResponse {
  total: number;
  items: AdminUser[];
}

export interface AdminUserCreate {
  user_name: string;
  password?: string;
  email?: string;
  role?: UserRole;
  auth_source?: 'password' | 'oidc';
}

export interface AdminUserUpdate {
  user_name?: string;
  email?: string;
  role?: UserRole;
  is_active?: boolean;
}

export interface PasswordResetRequest {
  new_password: string;
}

export interface RoleUpdateRequest {
  role: UserRole;
}

// Public Model Types
export interface AdminPublicModel {
  id: number;
  name: string;
  namespace: string;
  json: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminPublicModelListResponse {
  total: number;
  items: AdminPublicModel[];
}

export interface AdminPublicModelCreate {
  name: string;
  namespace?: string;
  json: Record<string, unknown>;
}

export interface AdminPublicModelUpdate {
  name?: string;
  namespace?: string;
  json?: Record<string, unknown>;
  is_active?: boolean;
}

// System Stats Types
export interface SystemStats {
  total_users: number;
  active_users: number;
  admin_count: number;
  total_tasks: number;
  total_public_models: number;
}

// Admin API Services
export const adminApis = {
  // ==================== User Management ====================

  /**
   * Get list of all users with pagination
   */
  async getUsers(
    page: number = 1,
    limit: number = 20,
    includeInactive: boolean = false
  ): Promise<AdminUserListResponse> {
    const params = new URLSearchParams();
    params.append('page', String(page));
    params.append('limit', String(limit));
    if (includeInactive) {
      params.append('include_inactive', 'true');
    }
    return apiClient.get(`/admin/users?${params.toString()}`);
  },

  /**
   * Get user by ID
   */
  async getUserById(userId: number): Promise<AdminUser> {
    return apiClient.get(`/admin/users/${userId}`);
  },

  /**
   * Create a new user
   */
  async createUser(userData: AdminUserCreate): Promise<AdminUser> {
    return apiClient.post('/admin/users', userData);
  },

  /**
   * Update user information
   */
  async updateUser(userId: number, userData: AdminUserUpdate): Promise<AdminUser> {
    return apiClient.put(`/admin/users/${userId}`, userData);
  },

  /**
   * Delete a user (soft delete)
   */
  async deleteUser(userId: number): Promise<void> {
    return apiClient.delete(`/admin/users/${userId}`);
  },

  /**
   * Reset user password
   */
  async resetPassword(userId: number, data: PasswordResetRequest): Promise<AdminUser> {
    return apiClient.post(`/admin/users/${userId}/reset-password`, data);
  },

  /**
   * Toggle user active status
   */
  async toggleUserStatus(userId: number): Promise<AdminUser> {
    return apiClient.post(`/admin/users/${userId}/toggle-status`);
  },

  /**
   * Update user role
   */
  async updateUserRole(userId: number, data: RoleUpdateRequest): Promise<AdminUser> {
    return apiClient.put(`/admin/users/${userId}/role`, data);
  },

  // ==================== Public Model Management ====================

  /**
   * Get list of all public models with pagination
   */
  async getPublicModels(
    page: number = 1,
    limit: number = 20
  ): Promise<AdminPublicModelListResponse> {
    return apiClient.get(`/admin/public-models?page=${page}&limit=${limit}`);
  },

  /**
   * Create a new public model
   */
  async createPublicModel(modelData: AdminPublicModelCreate): Promise<AdminPublicModel> {
    return apiClient.post('/admin/public-models', modelData);
  },

  /**
   * Update a public model
   */
  async updatePublicModel(
    modelId: number,
    modelData: AdminPublicModelUpdate
  ): Promise<AdminPublicModel> {
    return apiClient.put(`/admin/public-models/${modelId}`, modelData);
  },

  /**
   * Delete a public model
   */
  async deletePublicModel(modelId: number): Promise<void> {
    return apiClient.delete(`/admin/public-models/${modelId}`);
  },

  // ==================== System Stats ====================

  /**
   * Get system statistics
   */
  async getSystemStats(): Promise<SystemStats> {
    return apiClient.get('/admin/stats');
  },
};
