// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool icons mapping
 */
export const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Write: '📝',
  Edit: '✏️',
  Bash: '⚙️',
  Grep: '🔍',
  Glob: '📁',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '🤖',
  TodoWrite: '📋',
  NotebookEdit: '📓',
  // Lowercase aliases for backward compatibility
  read: '📖',
  write: '📝',
  edit: '✏️',
  bash: '⚙️',
  grep: '🔍',
  glob: '📁',
  webfetch: '🌐',
  websearch: '🔎',
  task: '🤖',
  todowrite: '📋',
  notebookedit: '📓',
}

/**
 * Get icon for a tool
 */
export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || TOOL_ICONS[toolName.toLowerCase()] || '🔧'
}

/**
 * Maximum output length before truncation (characters)
 */
export const MAX_OUTPUT_LENGTH = 5000

/**
 * Maximum lines to show before collapsing
 */
export const MAX_OUTPUT_LINES = 100

/**
 * Truncation threshold for preview
 */
export const TRUNCATION_PREVIEW_LENGTH = 200
