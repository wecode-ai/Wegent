// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage abstraction layer for browser extensions
 * Provides a unified interface for both Chrome and Safari
 */

import browser from 'webextension-polyfill'
export interface StorageData {
  token?: string
  serverUrl?: string
  frontendUrl?: string
  defaultExtractionMode?: 'selection' | 'fullPage'
  defaultKnowledgeBaseId?: number
  user?: {
    id: number
    user_name: string
    avatar?: string
  }
}

const STORAGE_KEYS = {
  TOKEN: 'wegent_token',
  SERVER_URL: 'wegent_server_url',
  FRONTEND_URL: 'wegent_frontend_url',
  DEFAULT_EXTRACTION_MODE: 'wegent_default_extraction_mode',
  DEFAULT_KNOWLEDGE_BASE_ID: 'wegent_default_kb_id',
  USER: 'wegent_user',
} as const

/**
 * Get value from sync storage
 */
export async function getStorageValue<K extends keyof StorageData>(
  key: K,
): Promise<StorageData[K] | undefined> {
  const storageKey = getStorageKey(key)
  const result = await browser.storage.sync.get(storageKey)
  return result[storageKey] as StorageData[K] | undefined
}

/**
 * Set value in sync storage
 */
export async function setStorageValue<K extends keyof StorageData>(
  key: K,
  value: StorageData[K],
): Promise<void> {
  const storageKey = getStorageKey(key)
  await browser.storage.sync.set({ [storageKey]: value })
}

/**
 * Remove value from sync storage
 */
export async function removeStorageValue<K extends keyof StorageData>(key: K): Promise<void> {
  const storageKey = getStorageKey(key)
  await browser.storage.sync.remove(storageKey)
}

/**
 * Get all storage data
 */
export async function getAllStorageData(): Promise<StorageData> {
  const result = await browser.storage.sync.get(Object.values(STORAGE_KEYS))
  return {
    token: result[STORAGE_KEYS.TOKEN],
    serverUrl: result[STORAGE_KEYS.SERVER_URL],
    frontendUrl: result[STORAGE_KEYS.FRONTEND_URL],
    defaultExtractionMode: result[STORAGE_KEYS.DEFAULT_EXTRACTION_MODE],
    defaultKnowledgeBaseId: result[STORAGE_KEYS.DEFAULT_KNOWLEDGE_BASE_ID],
    user: result[STORAGE_KEYS.USER],
  }
}

/**
 * Clear all storage data
 */
export async function clearAllStorageData(): Promise<void> {
  await browser.storage.sync.remove(Object.values(STORAGE_KEYS))
}

/**
 * Get storage key from data key
 */
function getStorageKey(key: keyof StorageData): string {
  const keyMap: Record<keyof StorageData, string> = {
    token: STORAGE_KEYS.TOKEN,
    serverUrl: STORAGE_KEYS.SERVER_URL,
    frontendUrl: STORAGE_KEYS.FRONTEND_URL,
    defaultExtractionMode: STORAGE_KEYS.DEFAULT_EXTRACTION_MODE,
    defaultKnowledgeBaseId: STORAGE_KEYS.DEFAULT_KNOWLEDGE_BASE_ID,
    user: STORAGE_KEYS.USER,
  }
  return keyMap[key]
}

/**
 * Listen for storage changes
 */
export function onStorageChange(
  callback: (changes: Partial<StorageData>) => void,
): () => void {
  const listener = (
    changes: { [key: string]: browser.Storage.StorageChange },
    areaName: string,
  ) => {
    if (areaName !== 'sync') return

    const mappedChanges: Partial<StorageData> = {}

    if (STORAGE_KEYS.TOKEN in changes) {
      mappedChanges.token = changes[STORAGE_KEYS.TOKEN].newValue
    }
    if (STORAGE_KEYS.SERVER_URL in changes) {
      mappedChanges.serverUrl = changes[STORAGE_KEYS.SERVER_URL].newValue
    }
    if (STORAGE_KEYS.FRONTEND_URL in changes) {
      mappedChanges.frontendUrl = changes[STORAGE_KEYS.FRONTEND_URL].newValue
    }
    if (STORAGE_KEYS.DEFAULT_EXTRACTION_MODE in changes) {
      mappedChanges.defaultExtractionMode = changes[STORAGE_KEYS.DEFAULT_EXTRACTION_MODE].newValue
    }
    if (STORAGE_KEYS.DEFAULT_KNOWLEDGE_BASE_ID in changes) {
      mappedChanges.defaultKnowledgeBaseId = changes[STORAGE_KEYS.DEFAULT_KNOWLEDGE_BASE_ID].newValue
    }
    if (STORAGE_KEYS.USER in changes) {
      mappedChanges.user = changes[STORAGE_KEYS.USER].newValue
    }

    if (Object.keys(mappedChanges).length > 0) {
      callback(mappedChanges)
    }
  }

  browser.storage.onChanged.addListener(listener)
  return () => browser.storage.onChanged.removeListener(listener)
}
