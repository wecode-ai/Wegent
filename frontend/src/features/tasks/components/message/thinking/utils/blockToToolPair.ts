// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ThinkingStep, ToolBlock, ToolPair, ToolStatus } from '../types'
import { normalizeToolName, normalizeStepDetails } from './toolExtractor'

const SUPPORTED_TOOL_STATUSES: ToolStatus[] = [
  'generating_arguments',
  'pending',
  'streaming',
  'invoking',
  'done',
  'error',
]

function normalizeToolStatus(status: ToolBlock['status']): ToolStatus {
  if (status && SUPPORTED_TOOL_STATUSES.includes(status as ToolStatus)) {
    return status as ToolStatus
  }
  return 'done'
}

export function blockToToolPair(block: ToolBlock): ToolPair {
  const normalizedToolName = normalizeToolName(block.tool_name || 'unknown')
  const rawToolUseStep: ThinkingStep = {
    title: `Using ${normalizedToolName}`,
    next_action: 'continue',
    tool_use_id: block.tool_use_id,
    details: {
      type: 'tool_use',
      tool_name: normalizedToolName,
      status: 'started',
      input: block.tool_input,
    },
  }
  const rawToolResultStep: ThinkingStep | undefined =
    block.tool_output != null || block.status === 'error'
      ? {
          title: `Result from ${normalizedToolName}`,
          next_action: 'continue',
          tool_use_id: block.tool_use_id,
          details: {
            type: 'tool_result',
            tool_name: normalizedToolName,
            status: block.status === 'error' ? 'failed' : 'completed',
            is_error: block.status === 'error',
            content:
              block.tool_output != null
                ? typeof block.tool_output === 'string'
                  ? block.tool_output
                  : JSON.stringify(block.tool_output)
                : undefined,
            output: block.tool_output,
          },
        }
      : undefined

  return {
    toolUseId: block.tool_use_id || block.id,
    toolName: normalizedToolName,
    displayName: block.display_name,
    status: normalizeToolStatus(block.status),
    toolUse: normalizeStepDetails(rawToolUseStep),
    toolResult: rawToolResultStep ? normalizeStepDetails(rawToolResultStep) : undefined,
  }
}
