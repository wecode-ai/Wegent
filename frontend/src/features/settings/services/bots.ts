// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { botApis } from '@/apis/bots'
import { Bot, PaginationParams } from '@/types/api'
import { CreateBotRequest, UpdateBotRequest } from '@/apis/bots'

/**
 * Get Bot list
 */
export async function fetchBotsList(): Promise<Bot[]> {
  const params: PaginationParams = {}
  const botsData = await botApis.getBots(params)
  return Array.isArray(botsData.items) ? botsData.items : []
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
 */
export async function deleteBot(id: number): Promise<void> {
  await botApis.deleteBot(id)
}
/**
 * Check if the agent config is for a predefined model.
 * A predefined model config only contains the 'private_model' field.
 * @param config The agent configuration object.
 * @returns True if it's a predefined model, false otherwise.
 */
export const isPredefinedModel = (config: any): boolean => {
  if (!config) return false;
  const keys = Object.keys(config);
  return keys.length === 1 && keys[0] === 'private_model';
}

/**
 * Get the model name from a predefined model configuration.
 * @param config The agent configuration object.
 * @returns The model name, or an empty string if not found.
 */
export const getModelFromConfig = (config: any): string => {
  if (!config) return '';
  return config.private_model || '';
}