// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Attachment Service
 *
 * Centralized service for managing file attachment functionality.
 * This service provides:
 * - Shell type detection for attachment support
 * - Drag and drop handling utilities
 * - File validation utilities
 *
 * All attachment-related logic should be imported from this service
 * to ensure consistency across the application.
 */

import type { Team } from '@/types/api'

/**
 * Shell types that support file attachments.
 * Add new shell types here when they gain attachment support.
 */
const ATTACHMENT_SUPPORTED_SHELL_TYPES = ['chat', 'claudecode'] as const

/**
 * Agent types that support file attachments.
 * This maps to team.agent_type field.
 */
const ATTACHMENT_SUPPORTED_AGENT_TYPES = ['chat', 'claudecode'] as const

/**
 * Check if a team uses Chat Shell type.
 *
 * @param team - Team to check
 * @returns true if the team uses Chat Shell
 */
export function isChatShell(team: Team | null): boolean {
  if (!team) return false

  // Primary check: agent_type field (case-insensitive)
  if (team.agent_type?.toLowerCase() === 'chat') {
    return true
  }

  // Fallback: check first bot's shell_type
  if (team.bots && team.bots.length > 0) {
    const firstBot = team.bots[0]
    if (firstBot.bot?.shell_type?.toLowerCase() === 'chat') {
      return true
    }
  }

  return false
}

/**
 * Check if a team uses ClaudeCode Shell type.
 *
 * @param team - Team to check
 * @returns true if the team uses ClaudeCode Shell
 */
export function isClaudeCodeShell(team: Team | null): boolean {
  if (!team) return false

  // Primary check: agent_type field (case-insensitive)
  if (team.agent_type?.toLowerCase() === 'claudecode') {
    return true
  }

  // Fallback: check first bot's shell_type
  if (team.bots && team.bots.length > 0) {
    const firstBot = team.bots[0]
    if (firstBot.bot?.shell_type?.toLowerCase() === 'claudecode') {
      return true
    }
  }

  return false
}

/**
 * Check if a team supports file attachments.
 *
 * This is the primary function to use when determining whether to show
 * attachment-related UI elements (upload button, drag overlay, etc.)
 *
 * Currently supports:
 * - Chat Shell: Full attachment support with vision for images
 * - ClaudeCode Shell: Attachments downloaded to workspace
 *
 * @param team - Team to check
 * @returns true if the team supports file attachments
 */
export function supportsAttachments(team: Team | null): boolean {
  if (!team) return false

  // Check agent_type first (primary method)
  const agentType = team.agent_type?.toLowerCase()
  if (
    agentType &&
    ATTACHMENT_SUPPORTED_AGENT_TYPES.includes(
      agentType as (typeof ATTACHMENT_SUPPORTED_AGENT_TYPES)[number]
    )
  ) {
    return true
  }

  // Fallback: check first bot's shell_type
  if (team.bots && team.bots.length > 0) {
    const shellType = team.bots[0]?.bot?.shell_type?.toLowerCase()
    if (
      shellType &&
      ATTACHMENT_SUPPORTED_SHELL_TYPES.includes(
        shellType as (typeof ATTACHMENT_SUPPORTED_SHELL_TYPES)[number]
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * Get the shell type of a team.
 *
 * @param team - Team to check
 * @returns Shell type string or null
 */
export function getShellType(team: Team | null): string | null {
  if (!team) return null

  // Check agent_type first
  if (team.agent_type) {
    return team.agent_type.toLowerCase()
  }

  // Fallback: check first bot's shell_type
  if (team.bots && team.bots.length > 0) {
    return team.bots[0]?.bot?.shell_type?.toLowerCase() || null
  }

  return null
}

/**
 * Check if drag and drop should be enabled for a team.
 * This is equivalent to supportsAttachments but named for clarity in drag/drop contexts.
 *
 * @param team - Team to check
 * @returns true if drag and drop should be enabled
 */
export function isDragDropEnabled(team: Team | null): boolean {
  return supportsAttachments(team)
}

/**
 * Check if paste file should be enabled for a team.
 * This is equivalent to supportsAttachments but named for clarity in paste contexts.
 *
 * @param team - Team to check
 * @returns true if paste file should be enabled
 */
export function isPasteFileEnabled(team: Team | null): boolean {
  return supportsAttachments(team)
}

/**
 * Attachment service exports
 */
export const attachmentService = {
  isChatShell,
  isClaudeCodeShell,
  supportsAttachments,
  getShellType,
  isDragDropEnabled,
  isPasteFileEnabled,
}

export default attachmentService
