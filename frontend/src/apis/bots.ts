// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';
import { Bot, PaginationParams, SuccessMessage } from '../types/api';

// Bot Request/Response Types
export interface CreateBotRequest {
  name: string;
  shell_name: string; // Shell name (e.g., 'ClaudeCode', 'Agno', 'my-custom-shell')
  agent_config: Record<string, unknown>;
  system_prompt: string;
  mcp_servers: Record<string, unknown>;
  skills?: string[];
}

export interface UpdateBotRequest {
  name?: string;
  shell_name?: string; // Shell name (e.g., 'ClaudeCode', 'Agno', 'my-custom-shell')
  agent_config?: Record<string, unknown>;
  system_prompt?: string;
  mcp_servers?: Record<string, unknown>;
  skills?: string[];
  is_active?: boolean;
}

export interface BotListResponse {
  total: number;
  items: Bot[];
}

// Bot Services
export const botApis = {
  async getBots(params?: PaginationParams): Promise<BotListResponse> {
    const query = params ? `?page=${params.page || 1}&limit=${params.limit || 100}` : '';
    return apiClient.get(`/bots${query}`);
  },

  async getBot(id: number): Promise<Bot> {
    return apiClient.get(`/bots/${id}`);
  },

  async createBot(data: CreateBotRequest): Promise<Bot> {
    return apiClient.post('/bots', data);
  },

  async updateBot(id: number, data: UpdateBotRequest): Promise<Bot> {
    return apiClient.put(`/bots/${id}`, data);
  },

  async deleteBot(id: number): Promise<SuccessMessage> {
    return apiClient.delete(`/bots/${id}`);
  },
};
