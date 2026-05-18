// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool extraction utilities
 *
 * Extracts tool call pairs from thinking steps and groups consecutive tools.
 */

import type { ThinkingStep, ToolPair, ToolGroup, ToolStatus } from '../types'

/**
 * Claude Code truncated content object.
 * When a field value is too large, Claude Code replaces it with this object.
 */
interface TruncatedContent {
  length: number
  omitted: boolean
  preview: string
  sha256: string
}

function isTruncatedContent(value: unknown): value is TruncatedContent {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.preview === 'string' && typeof obj.omitted === 'boolean'
}

/**
 * Convert a value that may be a truncated content object into a plain string.
 * Returns undefined for null/undefined inputs.
 */
function resolveTruncated(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (!isTruncatedContent(value)) return value
  const suffix = value.omitted ? ` ... [${value.length} chars total, content truncated]` : ''
  return value.preview + suffix
}

/**
 * Recursively walk an input object and resolve any truncated content values.
 */
function resolveInputFields(
  input: string | Record<string, unknown> | undefined
): string | Record<string, unknown> | undefined {
  if (!input) return input
  if (typeof input === 'string') return input
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(input)) {
    result[key] = resolveTruncated(val)
  }
  return result
}

/**
 * Normalize a ThinkingStep so that any truncated content objects inside
 * `details` are converted to plain strings before the step is used for rendering.
 *
 * This is the single place where Claude Code's large-content truncation is handled,
 * so individual renderers never need to deal with non-string values.
 */
export function normalizeStepDetails(step: ThinkingStep): ThinkingStep {
  if (!step.details) return step
  const d = step.details

  // Normalize tool input fields
  const normalizedInput = resolveInputFields(
    d.input as string | Record<string, unknown> | undefined
  )

  // Normalize tool result output/content fields
  const normalizedContent =
    d.content !== undefined ? (resolveTruncated(d.content) as string | undefined) : d.content
  const normalizedOutput = d.output !== undefined ? resolveTruncated(d.output) : d.output

  // Normalize message.content array items (text/tool_use/tool_result content fields)
  let normalizedMessageContent = d.message?.content
  if (Array.isArray(d.message?.content)) {
    const resolved = d.message!.content.map(item => {
      const changes: Record<string, unknown> = {}
      if (item.text !== undefined) {
        const r = resolveTruncated(item.text)
        if (r !== item.text) changes.text = r
      }
      if (item.content !== undefined) {
        const r = resolveTruncated(item.content)
        if (r !== item.content) changes.content = r
      }
      if (item.input !== undefined) {
        const r = resolveInputFields(item.input as string | Record<string, unknown> | undefined)
        if (r !== item.input) changes.input = r
      }
      return Object.keys(changes).length > 0 ? { ...item, ...changes } : item
    })
    // Only replace if something actually changed
    if (resolved.some((item, i) => item !== d.message!.content![i])) {
      normalizedMessageContent = resolved
    }
  }

  const messageChanged = normalizedMessageContent !== d.message?.content

  if (
    normalizedInput === d.input &&
    normalizedContent === d.content &&
    normalizedOutput === d.output &&
    !messageChanged
  ) {
    return step
  }

  return {
    ...step,
    details: {
      ...d,
      ...(normalizedInput !== d.input ? { input: normalizedInput } : {}),
      ...(normalizedContent !== d.content ? { content: normalizedContent as string } : {}),
      ...(normalizedOutput !== d.output ? { output: normalizedOutput } : {}),
      ...(messageChanged ? { message: { ...d.message, content: normalizedMessageContent } } : {}),
    },
  }
}

/**
 * Normalize an entire thinking array, resolving all truncated content objects.
 * Call this once at the data entry point so all downstream components receive clean strings.
 */
export function normalizeThinkingSteps(thinking: ThinkingStep[]): ThinkingStep[] {
  return thinking.map(normalizeStepDetails)
}

/**
 * Normalize tool names from Chat shell (Chinese) to standard English names
 * This ensures specialized renderers are invoked correctly
 */
export function normalizeToolName(toolName: string, _title?: string): string {
  if (_title) {
    return _title
  }

  // Direct mapping for known English names
  const englishTools = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'TodoWrite',
    'Task',
    'WebFetch',
    'WebSearch',
    'Upload',
  ]
  if (englishTools.includes(toolName)) {
    return toolName
  }

  // Try pattern matching for tool names
  // Check specific patterns first, then broader patterns
  if (toolName.includes('upload') || toolName.includes('Upload')) {
    return 'Upload'
  }
  if (toolName.includes('list') || toolName.includes('glob') || toolName.includes('find')) {
    return 'Glob'
  }
  if (toolName.includes('read') || toolName.includes('Read')) {
    return 'Read'
  }
  if (toolName.includes('write') || toolName.includes('Write')) {
    return 'Write'
  }
  if (toolName.includes('edit') || toolName.includes('Edit')) {
    return 'Edit'
  }
  if (toolName.includes('grep')) {
    return 'Grep'
  }
  if (toolName.includes('bash') || toolName.includes('exec') || toolName.includes('command')) {
    return 'Bash'
  }
  // Keep knowledge_base_search and web_search as-is
  if (toolName.includes('knowledge') || toolName.includes('kb')) {
    return 'knowledge_base_search'
  }
  if (toolName.includes('web') && toolName.includes('search')) {
    return 'WebSearch'
  }

  // Return original if no mapping found
  return toolName
}

/**
 * Extract tool pairs from thinking steps
 * Matches tool_use with tool_result using tool_use_id (or run_id as fallback)
 */
export function extractToolPairs(thinking: ThinkingStep[]): ToolPair[] {
  const pairs: ToolPair[] = []
  const toolUseMap = new Map<string, { step: ThinkingStep; index: number }>()

  thinking.forEach((step, index) => {
    const details = step.details
    if (!details) return

    // Get identifier (prefer tool_use_id, fallback to run_id)
    const toolId = step.tool_use_id || step.run_id
    if (!toolId) {
      return
    }

    const rawToolName = details.tool_name || details.name || 'unknown'
    const toolName = normalizeToolName(rawToolName, step.title)

    // Handle tool_use (both new format and Chat shell format)
    if (details.type === 'tool_use') {
      // For Chat shell: status === 'started'
      // For new format: no status check needed
      if (!details.status || details.status === 'started') {
        toolUseMap.set(toolId, { step, index })
      }
    }
    // Handle tool_result (both new format and Chat shell format)
    else if (details.type === 'tool_result') {
      // For Chat shell: status === 'completed' or 'failed'
      // For new format: any status
      const toolUse = toolUseMap.get(toolId)
      if (toolUse) {
        const status = getToolStatus(details)
        pairs.push({
          toolUseId: toolId,
          toolName,
          status,
          toolUse: toolUse.step,
          toolResult: step,
        })
      }
    }
    // Handle assistant message with content array (existing data structure)
    else if (details.type === 'assistant' && details.message?.content) {
      const content = details.message.content
      if (Array.isArray(content)) {
        content.forEach((item: { type?: string; id?: string; name?: string }) => {
          if (item.type === 'tool_use') {
            const itemToolId = item.id || step.run_id
            if (itemToolId) {
              toolUseMap.set(itemToolId, { step, index })
            }
          }
        })
      }
    }
    // Handle tool_result in user message
    else if (details.type === 'user' && details.message?.content) {
      const content = details.message.content
      if (Array.isArray(content)) {
        content.forEach((item: { type?: string; tool_use_id?: string; is_error?: boolean }) => {
          if (item.type === 'tool_result') {
            const itemToolId = item.tool_use_id || step.run_id
            if (itemToolId) {
              const toolUse = toolUseMap.get(itemToolId)
              if (toolUse) {
                const status = item.is_error ? 'error' : 'done'
                pairs.push({
                  toolUseId: itemToolId,
                  toolName: 'Tool', // Will be determined from tool_use
                  status,
                  toolUse: toolUse.step,
                  toolResult: step,
                })
              }
            }
          }
        })
      }
    }
  })

  // Handle incomplete pairs (tool_use without result - still streaming)
  toolUseMap.forEach((toolUse, toolId) => {
    if (!pairs.find(p => p.toolUseId === toolId)) {
      const rawToolName = toolUse.step.details?.tool_name || toolUse.step.details?.name || 'unknown'
      const toolName = normalizeToolName(rawToolName, toolUse.step.title)
      pairs.push({
        toolUseId: toolId,
        toolName,
        status: 'invoking',
        toolUse: toolUse.step,
      })
    }
  })

  return pairs
}

/**
 * Group consecutive tool pairs into ToolGroups
 * For now, we group all tools into a single group
 * TODO: Implement smart grouping based on thinking step indices
 */
export function groupConsecutiveTools(pairs: ToolPair[]): ToolGroup[] {
  if (pairs.length === 0) return []

  // Simple grouping: all tools in one group
  // In the future, we can analyze thinking array indices to group consecutive tools
  const group: ToolGroup = {
    id: `group-${pairs[0].toolUseId}`,
    tools: pairs,
    isComplete: pairs.every(t => t.status === 'done' || t.status === 'error'),
  }

  return [group]
}

/**
 * Determine tool status from tool_result details
 */
function getToolStatus(details: ThinkingStep['details']): ToolStatus {
  if (details?.status === 'failed' || details?.is_error || details?.error) {
    return 'error'
  }
  if (details?.status === 'completed') {
    return 'done'
  }
  if (details?.status === 'started') {
    return 'invoking'
  }
  return 'invoking'
}

/**
 * Check if a thinking step is a tool-related step
 */
export function isToolStep(step: ThinkingStep): boolean {
  return step.details?.type === 'tool_use' || step.details?.type === 'tool_result'
}

/**
 * Filter out tool steps from thinking array (for non-tool timeline rendering)
 */
export function filterNonToolSteps(thinking: ThinkingStep[]): ThinkingStep[] {
  return thinking.filter(step => !isToolStep(step))
}
