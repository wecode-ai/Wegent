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