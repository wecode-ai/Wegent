// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth section registry for extensible knowledge base authorization.
 *
 * Allows internal deployments (e.g., wecode) to register additional
 * authorization sections for external entity types without modifying
 * open-source components.
 *
 * Built-in sections (user, namespace) are registered by the OSS core.
 * Internal extensions register via registerAuthSection() at module load time.
 */

import type { ReactNode } from 'react'
import type { MemberRole } from '@/types/knowledge'

/** Entry representing a selected authorization target */
export interface AuthEntry {
  id: string
  label: string
  entityType: string
  entityId: string
  role: MemberRole
}

export interface AuthSectionConfig {
  /** Entity type identifier, e.g. 'user', 'namespace', or other registered types */
  type: string
  /** i18n key for the section label */
  labelKey: string
  /** Render the search/select UI for this section */
  renderSearch: (props: {
    role: MemberRole
    onSelect: (entry: AuthEntry) => void
    /** Optional entity ID to exclude from search results (e.g. the KB's owning namespace) */
    excludedEntityId?: string
  }) => ReactNode
}

const registry: AuthSectionConfig[] = []
const listeners: Set<() => void> = new Set()

function notify() {
  listeners.forEach(l => l())
}

/**
 * Subscribe to registry changes (e.g., when new sections are registered
 * asynchronously via dynamic imports).
 */
export function subscribeAuthSections(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Register an auth section configuration.
 * Call at module load time (top-level of a feature module).
 */
export function registerAuthSection(config: AuthSectionConfig): void {
  // Prevent duplicate registrations
  const existingIndex = registry.findIndex(r => r.type === config.type)
  if (existingIndex >= 0) {
    registry[existingIndex] = config
  } else {
    registry.push(config)
  }
  notify()
}

/** Get all registered auth section configs */
export function getAuthSections(): AuthSectionConfig[] {
  return [...registry]
}
