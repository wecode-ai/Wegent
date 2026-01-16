// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Main component
export { default as ThinkingDisplay } from './ThinkingDisplay'
export { default } from './ThinkingDisplay'

// View containers
export { default as SimpleThinkingView } from './SimpleThinkingView'
export { default as DetailedThinkingView } from './DetailedThinkingView'

// Reasoning display for DeepSeek R1 and similar models
export { default as ReasoningDisplay } from './ReasoningDisplay'

// Reusable components
export { default as ThinkingHeader } from './components/ThinkingHeader'
export { default as ToolCallItem } from './components/ToolCallItem'
export { default as ToolResultItem } from './components/ToolResultItem'
export { default as TodoListDisplay } from './components/TodoListDisplay'
export { default as SystemInfoDisplay } from './components/SystemInfoDisplay'
export { default as ErrorDisplay } from './components/ErrorDisplay'
export { default as CollapsibleContent } from './components/CollapsibleContent'
export { default as ScrollToBottom } from './components/ScrollToBottom'

// Hooks
export { useThinkingState } from './hooks/useThinkingState'

// Types
export type {
  ThinkingStep,
  TodoItem,
  McpServer,
  ThinkingDisplayProps,
  ThinkingHeaderProps,
  ToolCallItemProps,
  ToolResultItemProps,
  TodoListDisplayProps,
  SystemInfoDisplayProps,
  ErrorDisplayProps,
  CollapsibleContentProps,
  ScrollToBottomProps,
  ScrollState,
} from './types'

// Utils
export {
  extractToolCalls,
  calculateDuration,
  formatToolSummary,
  shouldCollapse,
  getContentPreview,
  formatConfidence,
  isTerminalStatus,
  isRunningStatus,
  parseTodoInput,
  parseToolCallTags,
  getThinkingText,
} from './utils/thinkingUtils'

// Constants
export {
  TOOL_ICONS,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_LENGTH,
  MAX_CONTENT_HEIGHT,
  SCROLL_THRESHOLD,
  TODO_STATUS_COLORS,
  MCP_STATUS_COLORS,
} from './utils/constants'
