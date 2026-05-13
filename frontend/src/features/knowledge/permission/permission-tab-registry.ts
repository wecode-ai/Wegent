// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission management tab registry.
 *
 * Provides an extension point for internal deployments to add
 * additional entity-type permission tabs for external entity types
 * to the knowledge base permission management panel.
 */

import type { ReactNode } from 'react'
import type { PermissionUserInfo } from '@/types/knowledge'

export interface PermissionTabConfig {
  /** Unique entity type identifier */
  type: string
  /** i18n translation key for tab label */
  labelKey: string
  /** Fallback label if translation key is not found */
  label?: string
  /** Optional icon rendered next to the label */
  icon?: ReactNode
  /**
   * Filter function to determine which approved members
   * belong to this tab.
   */
  filter: (user: PermissionUserInfo) => boolean
  /**
   * Optional render function for the add-permission button/dialog.
   */
  renderAddButton?: (props: { kbId: number; onSuccess: () => void }) => ReactNode
}

const registry: PermissionTabConfig[] = []
const listeners: Set<() => void> = new Set()

function notify() {
  listeners.forEach(l => l())
}

/**
 * Subscribe to registry changes (e.g., when new tabs are registered
 * asynchronously via dynamic imports).
 */
export function subscribePermissionTabs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Register a permission management tab for a specific entity type.
 */
export function registerPermissionTab(config: PermissionTabConfig): void {
  const existingIndex = registry.findIndex(r => r.type === config.type)
  if (existingIndex >= 0) {
    registry[existingIndex] = config
  } else {
    registry.push(config)
  }
  notify()
}

/**
 * Get all registered permission tab configurations.
 */
export function getPermissionTabs(): PermissionTabConfig[] {
  return [...registry]
}
