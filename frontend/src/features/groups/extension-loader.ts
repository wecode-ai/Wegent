// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group management extension loader (internal override).
 *
 * Directly loads @wecode/features/groups at runtime.
 * Supports both export default and named exports for compatibility
 * with the open-source extension contract.
 */

import type { ComponentType } from 'react'

export interface GroupExtensionProps {
  groupName: string
  onSuccess: () => void
  /** Optional cancel handler to close the add panel. */
  onCancel?: () => void
  userRole?: string
}

export interface GroupExtensionListProps {
  groupName: string
  canManage: boolean
  refreshTrigger?: number
  /** User's role in the group, for determining available role options. */
  userRole?: string
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

export async function loadGroupExtension(): Promise<GroupExtensionConfig | null> {
  try {
    const mod = await import('@wecode/features/groups')
    // Support both export default (internal) and named exports (OSS contract)
    if (mod.default) {
      return mod.default
    }
    const { addForm, listView, listTabLabel, addTabLabel } = mod
    if (!addForm || !listView) {
      console.warn(
        `Group extension module must export addForm and listView. ` +
          `Received addForm=${!!addForm}, listView=${!!listView}`
      )
      return null
    }
    return { listTabLabel, addTabLabel, addForm, listView }
  } catch (error) {
    console.warn('Failed to load group extension @wecode/features/groups', error)
    return null
  }
}
