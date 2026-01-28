// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from 'react'

/**
 * Tool metadata from backend (enhanced display information)
 */
export interface ToolMetadata {
  // Timing information
  started_at?: string
  completed_at?: string
  duration_ms?: number

  // File-related metadata (for Read/Write/Edit/Glob/Grep tools)
  file_path?: string
  file_name?: string
  line_count?: number
  file_size?: number
  match_count?: number

  // Command-related metadata (for Bash tool)
  command_description?: string
  exit_code?: number

  // Web-related metadata (for WebFetch/WebSearch tools)
  url?: string
  result_count?: number

  // Task-related metadata (for Task tool)
  subagent_type?: string
  task_description?: string

  // Content truncation info
  is_truncated?: boolean
  original_length?: number
}

/**
 * Tool details from backend
 */
export interface ToolDetails {
  type: 'tool_use' | 'tool_result' | 'system' | 'assistant' | 'user' | string
  tool_name?: string
  status?: 'start' | 'result' | 'error' | string
  input?: Record<string, unknown>
  output?: string
  is_error?: boolean
  error_message?: string
  metadata?: ToolMetadata
  message?: {
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: Record<string, unknown>
      content?: string
      is_error?: boolean
    }>
  }
  // Legacy fields for backward compatibility
  id?: string
  name?: string
  content?: string
  tool_use_id?: string
}

// Tool-specific input types
export interface ReadToolInput {
  file_path: string
  offset?: number
  limit?: number
}

export interface WriteToolInput {
  file_path: string
  content: string
}

export interface EditToolInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface BashToolInput {
  command: string
  description?: string
  timeout?: number
  run_in_background?: boolean
}

export interface GrepToolInput {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
  '-n'?: boolean
  '-A'?: number
  '-B'?: number
  '-C'?: number
}

export interface GlobToolInput {
  pattern: string
  path?: string
}

export interface WebFetchToolInput {
  url: string
  prompt: string
}

export interface WebSearchToolInput {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface TaskToolInput {
  description: string
  prompt: string
  subagent_type: string
  model?: string
}

export interface TodoWriteToolInput {
  todos: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm?: string
  }>
}

export interface NotebookEditToolInput {
  notebook_path: string
  new_source: string
  cell_id?: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: 'replace' | 'insert' | 'delete'
}

/**
 * Renderer props interface
 */
export interface ToolRendererProps<TInput = unknown> {
  toolName: string
  input?: TInput
  output?: string
  metadata?: ToolMetadata
  isLoading?: boolean // Tool is currently executing
  isError?: boolean
  errorMessage?: string
  itemIndex: number
}

/**
 * Renderer return type for Accordion
 */
export interface ToolRenderResult {
  key: string
  label: ReactNode
  children: ReactNode
}

/**
 * Registry types
 */
export type ToolRenderer<TInput = unknown> = (props: ToolRendererProps<TInput>) => ToolRenderResult
