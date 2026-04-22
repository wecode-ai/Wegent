// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export interface TemplateResourceGhostConfig {
  systemPrompt: string
  mcpServers?: Record<string, unknown>
  skills?: string[]
  skillRefs?: TemplateResourceSkillRef[]
}

export interface TemplateResourceSkillRef {
  name: string
  namespace: string
  userId: number
}

export interface TemplateResourceBotConfig {
  shellName: string
  agentConfig?: Record<string, unknown>
}

export interface TemplateResourceTeamConfig {
  collaborationModel?: string
  bindMode?: string[]
  description?: string
}

export interface TemplateResourceSubscriptionConfig {
  promptTemplate: string
  retryCount?: number
  timeoutSeconds?: number
}

export interface TemplateResourceQueueConfig {
  visibility?: string
  triggerMode?: string
}

export interface TemplateResources {
  ghost: TemplateResourceGhostConfig
  bot: TemplateResourceBotConfig
  team: TemplateResourceTeamConfig
  subscription: TemplateResourceSubscriptionConfig
  queue: TemplateResourceQueueConfig
}

export interface Template {
  id: number
  name: string
  displayName: string
  description: string | null
  category: string
  tags: string[]
  icon: string | null
  resources: TemplateResources
  createdAt: string
  updatedAt: string
}

export interface TemplateListResponse {
  total: number
  items: Template[]
}

export interface TemplateInstantiateResponse {
  ghostId: number
  botId: number
  teamId: number
  subscriptionId: number
  queueId: number
  queueName: string
}

export async function listTemplates(category?: string): Promise<TemplateListResponse> {
  const url = category ? `/templates?category=${encodeURIComponent(category)}` : '/templates'
  return apiClient.get<TemplateListResponse>(url)
}

export async function getTemplate(id: number): Promise<Template> {
  return apiClient.get<Template>(`/templates/${id}`)
}

export async function instantiateTemplate(id: number): Promise<TemplateInstantiateResponse> {
  return apiClient.post<TemplateInstantiateResponse>(`/templates/${id}/instantiate`)
}
