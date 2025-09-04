// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { botApis } from '@/apis/bots'
import { Bot } from '@/types/api'
import { CreateBotRequest, UpdateBotRequest } from '@/apis/bots'

/**
 * 获取Bot列表
 */
export async function fetchBotsList(): Promise<Bot[]> {
  const botsData = await botApis.getBots()
  return Array.isArray(botsData.items) ? botsData.items : []
}

/**
 * 创建Bot
 */
export async function createBot(data: CreateBotRequest): Promise<Bot> {
  return await botApis.createBot(data)
}

/**
 * 更新Bot
 */
export async function updateBot(id: number, data: UpdateBotRequest): Promise<Bot> {
  return await botApis.updateBot(id, data)
}

/**
 * 删除Bot
 */
export async function deleteBot(id: number): Promise<void> {
  await botApis.deleteBot(id)
}