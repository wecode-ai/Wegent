// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ToolRenderer, ToolRendererProps, ToolRenderResult } from './types'
import {
  ReadToolRenderer,
  WriteToolRenderer,
  EditToolRenderer,
  BashToolRenderer,
  GrepToolRenderer,
  GlobToolRenderer,
  WebFetchToolRenderer,
  WebSearchToolRenderer,
  TaskToolRenderer,
  TodoWriteToolRenderer,
  GenericToolRenderer,
} from './renderers'

/**
 * Tool renderer registry
 * Maps tool names to their specialized renderers
 */
const toolRegistry = new Map<string, ToolRenderer>([
  // File operations
  ['Read', ReadToolRenderer as ToolRenderer],
  ['Write', WriteToolRenderer as ToolRenderer],
  ['Edit', EditToolRenderer as ToolRenderer],

  // Command execution
  ['Bash', BashToolRenderer as ToolRenderer],

  // Search tools
  ['Grep', GrepToolRenderer as ToolRenderer],
  ['Glob', GlobToolRenderer as ToolRenderer],

  // Web tools
  ['WebFetch', WebFetchToolRenderer as ToolRenderer],
  ['WebSearch', WebSearchToolRenderer as ToolRenderer],

  // Task management
  ['Task', TaskToolRenderer as ToolRenderer],
  ['TodoWrite', TodoWriteToolRenderer as ToolRenderer],

  // Lowercase aliases for backward compatibility
  ['read', ReadToolRenderer as ToolRenderer],
  ['write', WriteToolRenderer as ToolRenderer],
  ['edit', EditToolRenderer as ToolRenderer],
  ['bash', BashToolRenderer as ToolRenderer],
  ['grep', GrepToolRenderer as ToolRenderer],
  ['glob', GlobToolRenderer as ToolRenderer],
  ['webfetch', WebFetchToolRenderer as ToolRenderer],
  ['websearch', WebSearchToolRenderer as ToolRenderer],
  ['task', TaskToolRenderer as ToolRenderer],
  ['todowrite', TodoWriteToolRenderer as ToolRenderer],
])

/**
 * Get the renderer for a specific tool
 * Falls back to GenericToolRenderer if no specific renderer exists
 */
export function getToolRenderer(toolName: string): ToolRenderer {
  return (
    toolRegistry.get(toolName) ||
    toolRegistry.get(toolName.toLowerCase()) ||
    (GenericToolRenderer as ToolRenderer)
  )
}

/**
 * Render a tool with its specialized renderer
 */
export function renderTool(
  toolName: string,
  props: Omit<ToolRendererProps, 'toolName'>
): ToolRenderResult {
  const renderer = getToolRenderer(toolName)
  return renderer({ ...props, toolName } as ToolRendererProps)
}

/**
 * Check if a tool has a specialized renderer
 */
export function hasSpecializedRenderer(toolName: string): boolean {
  return toolRegistry.has(toolName) || toolRegistry.has(toolName.toLowerCase())
}
