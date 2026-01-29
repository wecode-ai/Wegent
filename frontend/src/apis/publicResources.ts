// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Public Resources API Adapter Layer
 *
 * This module provides a unified API interface for managing public resources (bots, shells, models, teams)
 * that is compatible with the existing personal/group resource APIs.
 *
 * The adapter transforms Admin API responses to match the types used by existing components like BotEdit.
 */

import { Bot } from '@/types/api'
import { UnifiedShell } from './shells'
import { UnifiedModel } from './models'
import { adminApis, AdminPublicBot, AdminPublicShell, AdminPublicModel } from './admin'

/**
 * Transform AdminPublicBot to Bot type used by UI components
 */
export function transformPublicBotToBot(publicBot: AdminPublicBot): Bot {
  // Use the expanded fields from backend response directly
  // These fields are populated by the backend from the associated Ghost and Model resources
  const shellName = publicBot.shell_name || ''

  return {
    id: publicBot.id,
    name: publicBot.name,
    namespace: publicBot.namespace,
    shell_name: shellName,
    shell_type: shellName, // shell_type is the same as shell_name for public bots
    agent_config: publicBot.agent_config || {},
    system_prompt: publicBot.system_prompt || '',
    mcp_servers: publicBot.mcp_servers || {},
    skills: publicBot.skills || [],
    preload_skills: [], // preload_skills not supported for public bots yet
    is_active: publicBot.is_active,
    created_at: publicBot.created_at,
    updated_at: publicBot.updated_at,
  }
}

/**
 * Transform AdminPublicShell to UnifiedShell type
 */
export function transformPublicShellToUnifiedShell(publicShell: AdminPublicShell): UnifiedShell {
  const json = publicShell.json as Record<string, unknown>
  const spec = (json?.spec as Record<string, unknown>) || {}
  const metadata = (json?.metadata as Record<string, unknown>) || {}

  return {
    name: publicShell.name,
    type: 'public',
    displayName: (metadata?.displayName as string) || publicShell.display_name || null,
    shellType: publicShell.shell_type || (spec?.shellType as string) || '',
    baseImage: (spec?.baseImage as string) || null,
    baseShellRef: (spec?.baseShellRef as string) || null,
    supportModel: (spec?.supportModel as string[]) || null,
    executionType: (spec?.executionType as 'local_engine' | 'external_api') || null,
    namespace: publicShell.namespace,
    requiresWorkspace: (spec?.requiresWorkspace as boolean) ?? true,
  }
}

/**
 * Transform AdminPublicModel to UnifiedModel type
 */
export function transformPublicModelToUnifiedModel(publicModel: AdminPublicModel): UnifiedModel {
  const json = publicModel.json as Record<string, unknown>
  const spec = (json?.spec as Record<string, unknown>) || {}
  const metadata = (json?.metadata as Record<string, unknown>) || {}
  const modelConfig = (spec?.modelConfig as Record<string, unknown>) || {}
  const env = (modelConfig?.env as Record<string, unknown>) || {}

  return {
    name: publicModel.name,
    type: 'public',
    displayName: (metadata?.displayName as string) || publicModel.display_name || null,
    provider: (env?.model as string) || null,
    modelId: (env?.model_id as string) || null,
    namespace: publicModel.namespace,
    isActive: publicModel.is_active,
    modelCategoryType: (spec?.modelType as 'llm' | 'tts' | 'stt' | 'embedding' | 'rerank') || 'llm',
  }
}

/**
 * Form data for public bot creation/update
 *
 * The backend will auto-create Ghost and Model resources based on these fields.
 * This matches the structure used by BotEdit component.
 */
export interface PublicBotFormData {
  name: string
  namespace?: string
  shell_name: string // Required: reference to public Shell
  system_prompt?: string // System prompt for Ghost
  mcp_servers?: Record<string, unknown> // MCP servers config for Ghost
  skills?: string[] // Skills list for Ghost
  agent_config?: Record<string, unknown> // Agent config for Model
}
/**
 * Public Resources API - provides unified interface for public resource management
 */
export const publicResourceApis = {
  // ==================== Public Bots ====================

  /**
   * Get all public bots as Bot[] type
   */
  async getPublicBots(): Promise<Bot[]> {
    const response = await adminApis.getPublicBots(1, 1000)
    return response.items.map(transformPublicBotToBot)
  },

  /**
   * Create a public bot using form data mode
   * The backend will auto-create Ghost and Model resources
   */
  async createPublicBot(formData: PublicBotFormData): Promise<Bot> {
    const created = await adminApis.createPublicBot({
      name: formData.name,
      namespace: formData.namespace || 'default',
      shell_name: formData.shell_name,
      system_prompt: formData.system_prompt,
      mcp_servers: formData.mcp_servers,
      skills: formData.skills,
      agent_config: formData.agent_config,
    })
    return transformPublicBotToBot(created)
  },

  /**
   * Update a public bot using form data mode
   * The backend will auto-update Ghost and Model resources
   */
  async updatePublicBot(botId: number, formData: PublicBotFormData): Promise<Bot> {
    const updated = await adminApis.updatePublicBot(botId, {
      name: formData.name,
      namespace: formData.namespace || 'default',
      shell_name: formData.shell_name,
      system_prompt: formData.system_prompt,
      mcp_servers: formData.mcp_servers,
      skills: formData.skills,
      agent_config: formData.agent_config,
    })
    return transformPublicBotToBot(updated)
  },

  /**
   * Delete a public bot
   */
  async deletePublicBot(botId: number): Promise<void> {
    await adminApis.deletePublicBot(botId)
  },

  // ==================== Public Shells ====================

  /**
   * Get all public shells as UnifiedShell[] type
   */
  async getPublicShells(): Promise<UnifiedShell[]> {
    const response = await adminApis.getPublicShells(1, 1000)
    return response.items.map(transformPublicShellToUnifiedShell)
  },

  // ==================== Public Models ====================

  /**
   * Get all public models as UnifiedModel[] type
   * @param shellType - Optional shell type to filter compatible models
   * @param modelCategoryType - Optional model category type filter (llm, tts, stt, embedding, rerank)
   */
  async getPublicModels(
    shellType?: string,
    modelCategoryType?: 'llm' | 'tts' | 'stt' | 'embedding' | 'rerank'
  ): Promise<UnifiedModel[]> {
    const response = await adminApis.getPublicModels(1, 1000)
    let models = response.items.map(transformPublicModelToUnifiedModel)

    // Filter by model category type if provided
    if (modelCategoryType) {
      models = models.filter(m => m.modelCategoryType === modelCategoryType)
    }

    // Filter by shell type compatibility if provided
    // For now, we return all models - shell type filtering can be added later if needed
    // based on the shell's supportModel configuration

    return models
  },
}
