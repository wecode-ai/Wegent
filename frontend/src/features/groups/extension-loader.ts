// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group management extension loader.
 *
 * The open-source core ships with a default no-op implementation.
 * Internal deployments can set NEXT_PUBLIC_GROUP_EXTENSION_MODULE
 * to inject additional UI components (e.g., department management).
 *
 * The extension module must export:
 *   - tabLabel: string                // Label for the authorization tab
 *   - addForm: ComponentType          // Form rendered inside the add-member panel
 *   - listView: ComponentType         // List rendered inside the authorization tab
 *
 * Follows the same runtime dynamic import pattern as KB extensions.
 */

import type { ComponentType } from 'react'

export interface GroupExtensionProps {
  groupName: string
  onSuccess: () => void
  onCancel?: () => void
  userRole?: string
}

export interface GroupExtensionListProps {
  groupName: string
  canManage: boolean
  refreshTrigger?: number
  /**
   * Report the total number of entity authorizations back to the parent.
   * Call this once after data is loaded (not on every render) to avoid
   * excessive re-renders of the host dialog.
   */
  onCountChange?: (count: number) => void
}

export interface GroupExtensionConfig {
  listTabLabel: string
  addTabLabel: string
  addForm: ComponentType<GroupExtensionProps>
  listView: ComponentType<GroupExtensionListProps>
}

const EXTENSION_MODULE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_GROUP_EXTENSION_MODULE) || ''

export async function loadGroupExtension(): Promise<GroupExtensionConfig | null> {
  if (!EXTENSION_MODULE) {
    return null
  }
  try {
    const mod = await import(/* webpackIgnore: true */ EXTENSION_MODULE)
    const addForm = mod.addForm || mod.GroupExtension
    const listView = mod.listView || mod.GroupExtensionList
    const listTabLabel = mod.listTabLabel || mod.tabLabel || 'Authorizations'
    const addTabLabel = mod.addTabLabel || mod.tabLabel || 'Add Entity'
    if (!addForm || !listView) {
      console.warn(
        `Group extension module must export addForm and listView. ` +
          `Received addForm=${!!addForm}, listView=${!!listView}`
      )
      return null
    }
    return { listTabLabel, addTabLabel, addForm, listView }
  } catch (error) {
    console.warn(`Failed to load group extension module "${EXTENSION_MODULE}"`, error)
    return null
  }
}
