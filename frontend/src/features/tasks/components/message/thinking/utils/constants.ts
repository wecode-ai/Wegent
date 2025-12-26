// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool icon mapping for thinking display
 */
export const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '⚙️',
  Grep: '🔍',
  Glob: '📁',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
}

/**
 * Default max lines for collapsible content
 */
export const DEFAULT_MAX_LINES = 3

/**
 * Default max length for content preview
 */
export const DEFAULT_MAX_LENGTH = 300

/**
 * Max height for scrollable content area
 */
export const MAX_CONTENT_HEIGHT = 400

/**
 * Distance from bottom to trigger auto-scroll
 */
export const SCROLL_THRESHOLD = 24

/**
 * Todo status colors
 */
export const TODO_STATUS_COLORS = {
  pending: {
    bg: 'bg-gray-400',
    text: 'text-gray-400',
  },
  in_progress: {
    bg: 'bg-yellow-400',
    text: 'text-yellow-400',
  },
  completed: {
    bg: 'bg-green-400',
    text: 'text-green-400',
  },
} as const

/**
 * MCP server status colors
 */
export const MCP_STATUS_COLORS = {
  connected: {
    bg: 'bg-green-500/10',
    text: 'text-green-400',
  },
  disconnected: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
  },
} as const
