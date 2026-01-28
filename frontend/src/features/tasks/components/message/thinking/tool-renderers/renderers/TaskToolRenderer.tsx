// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, TaskToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput } from '../utils'

/**
 * Renderer for Task tool (sub-agent delegation)
 */
export function TaskToolRenderer(props: ToolRendererProps<TaskToolInput>): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading, isError } = props

  const subagentType = metadata?.subagent_type || input?.subagent_type
  const taskDescription = metadata?.task_description || input?.description

  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={taskDescription} width="200px" />}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
        isError={isError}
      />
    ),
    children: (
      <div className="text-sm space-y-2">
        {/* Sub-agent type */}
        {subagentType && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">
              {t('thinking.sections.subagentType') || 'Agent Type'}:
            </span>
            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
              {subagentType}
            </span>
          </div>
        )}

        {/* Task description */}
        {taskDescription && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.taskDescription') || 'Task'}
            </div>
            <div className="text-xs text-text-tertiary bg-muted/30 p-2 rounded-md">
              {taskDescription}
            </div>
          </div>
        )}

        {/* Prompt */}
        {input?.prompt && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.prompt') || 'Prompt'}
            </div>
            <pre className="whitespace-pre-wrap break-words text-xs text-text-tertiary overflow-x-auto max-h-40 overflow-y-auto rounded-md bg-muted/30 p-2">
              {input.prompt}
            </pre>
          </div>
        )}

        {/* Output */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.output') || 'Output'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-tertiary overflow-x-auto max-h-60 overflow-y-auto rounded-md bg-muted/30 p-2">
              {truncatedOutput}
            </pre>
            {isTruncated && <TruncatedIndicator originalLength={originalLength} />}
          </div>
        ) : isLoading ? (
          <SkeletonValue value={null} width="100%" height="80px" />
        ) : null}
      </div>
    ),
  }
}
