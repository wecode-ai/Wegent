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
 * Normalize tool names from Chat shell (Chinese) to standard English names
 * This ensures specialized renderers are invoked correctly
 */
export function normalizeToolName(toolName: string, title?: string): string {
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
  ]
  if (englishTools.includes(toolName)) {
    return toolName
  }

  // Map Chinese tool names to English equivalents
  const chineseToEnglish: Record<string, string> = {
    读取文件: 'Read',
    写入文件: 'Write',
    编辑文件: 'Edit',
    列出文件: 'Glob',
    搜索代码: 'Grep',
    执行命令: 'Bash',
    更新任务: 'TodoWrite',
    网页搜索: 'WebSearch',
    知识库搜索: 'knowledge_base_search',
  }

  // Try to match from toolName first
  if (chineseToEnglish[toolName]) {
    return chineseToEnglish[toolName]
  }

  // Try pattern matching for tool names
  // Match patterns like: sandbox_read_file, sandbox_write_file, sandbox_list_files
  // Check specific patterns first, then broader patterns
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

  // Try to extract from title if available
  if (title && typeof title === 'string') {
    // Remove common prefixes
    const cleanTitle = title.replace(/^(正在|使用|调用)/, '').trim()
    if (chineseToEnglish[cleanTitle]) {
      return chineseToEnglish[cleanTitle]
    }

    // Try pattern matching on title
    if (cleanTitle.includes('读取') || cleanTitle.includes('查看')) {
      return 'Read'
    }
    if (cleanTitle.includes('写入') || cleanTitle.includes('创建')) {
      return 'Write'
    }
    if (cleanTitle.includes('编辑') || cleanTitle.includes('修改')) {
      return 'Edit'
    }
    if (cleanTitle.includes('列出') || cleanTitle.includes('查找')) {
      return 'Glob'
    }
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
