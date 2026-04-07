// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from 'react'

/**
 * ChatArea team edit extension interface
 * Allows parent components to inject team editing functionality
 * without ChatArea directly depending on settings module
 */
export interface ChatAreaTeamEditExtension {
  /** Whether the current user can edit the team */
  canEdit: boolean
  /** Callback when user wants to edit the team */
  onEdit: () => void
  /** Render the team edit dialog (already manages its own open/close state) */
  renderDialog: () => ReactNode
}

/**
 * ChatArea extension interface for dependency injection
 * Allows parent components to inject additional functionality
 * without creating direct module dependencies
 */
export interface ChatAreaExtension {
  /** Team editing functionality */
  teamEdit?: ChatAreaTeamEditExtension
}
