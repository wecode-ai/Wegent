// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { botApis } from '@/apis/bots'
import { CheckRunningTasksResponse } from '@/apis/common'
import { Bot, PaginationParams } from '@/types/api'
import { CreateBotRequest, UpdateBotRequest } from '@/apis/bots'

/**
 * Get Bot list
 */
export async function fetchBotsList(
  scope?: 'personal' | 'group' | 'all',
  groupName?: string
): Promise<Bot[]> {
  const params: PaginationParams = {}
  const botsData = await botApis.getBots(params, scope, groupName)
  console.log('[DEBUG] fetchBotsList response:', JSON.stringify(botsData, null, 2))
  const items = Array.isArray(botsData.items) ? botsData.items : []
  // Log each bot's agent_config for debugging
  items.forEach((bot, index) => {
    console.log(`[DEBUG] Bot ${index} (${bot.name}):`, {
      id: bot.id,
      shell_type: bot.shell_type,
      agent_config: bot.agent_config,
    })
  })
  return items
}

/**
 * Create Bot
 */
export async function createBot(data: CreateBotRequest): Promise<Bot> {
  return await botApis.createBot(data)
}

/**
 * Update Bot
 */
export async function updateBot(id: number, data: UpdateBotRequest): Promise<Bot> {
  return await botApis.updateBot(id, data)
}

/**
 * Delete Bot
 * @param id - Bot ID
 * @param force - Force delete even if bot has running tasks
 */
export async function deleteBot(id: number, force: boolean = false): Promise<void> {
  await botApis.deleteBot(id, force)
}

/**
 * Check if bot has running tasks
 * @param id - Bot ID
 * @returns Running tasks info
 */
export async function checkBotRunningTasks(id: number): Promise<CheckRunningTasksResponse> {
  return await botApis.checkRunningTasks(id)
}
/**
 * Check if the agent config is for a predefined model.
 * A predefined model config contains 'bind_model' and optionally 'bind_model_type' and 'bind_model_namespace'.
 * @param config The agent configuration object.
 * @returns True if it's a predefined model, false otherwise.
 */
export const isPredefinedModel = (config: Record<string, unknown>): boolean => {
  if (!config) return false
  const keys = new Set(Object.keys(config))
  // Allow bind_model, optional bind_model_type, and optional bind_model_namespace
  const allowedKeys = new Set(['bind_model', 'bind_model_type', 'bind_model_namespace'])
  return keys.has('bind_model') && [...keys].every(k => allowedKeys.has(k))
}

/**
 * Get the model name from a predefined model configuration.
 * @param config The agent configuration object.
 * @returns The model name, or an empty string if not found.
 */
export const getModelFromConfig = (config: Record<string, unknown>): string => {
  if (!config) return ''
  return (config.bind_model as string) || ''
}

/**
 /**
  * Get the model type from a predefined model configuration.
  * @param config The agent configuration object.
  * @returns The model type ('public', 'user', or 'group'), or undefined if not specified.
  */
export const getModelTypeFromConfig = (
  config: Record<string, unknown>
): 'public' | 'user' | 'group' | undefined => {
  if (!config) return undefined
  const modelType = config.bind_model_type as string | undefined
  if (modelType === 'public' || modelType === 'user' || modelType === 'group') {
    return modelType
  }
  return undefined
}

/**
 * Get the model namespace from a predefined model configuration.
 * @param config The agent configuration object.
 * @returns The model namespace, or undefined if not specified.
 */
export const getModelNamespaceFromConfig = (
  config: Record<string, unknown>
): string | undefined => {
  if (!config) return undefined
  return config.bind_model_namespace as string | undefined
}

/**
 * Create a predefined model configuration with type and namespace.
 * @param modelName The model name.
 * @param modelType The model type ('public', 'user', or 'group').
 * @param modelNamespace The model namespace (defaults to 'default').
 * @returns The agent configuration object.
 */
export const createPredefinedModelConfig = (
  modelName: string,
  modelType?: 'public' | 'user' | 'group',
  modelNamespace?: string
): Record<string, unknown> => {
  const config: Record<string, unknown> = { bind_model: modelName }
  if (modelType) {
    config.bind_model_type = modelType
  }
  if (modelNamespace && modelNamespace !== 'default') {
    config.bind_model_namespace = modelNamespace
  }
  return config
}
