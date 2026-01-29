// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import type { ThinkingStep } from './types'
import { useToolExtraction } from './hooks/useToolExtraction'
import { isRunningStatus } from './utils/thinkingUtils'
import { ToolBlockGroup } from './components/ToolBlockGroup'

interface ToolBlocksViewProps {
  thinking: ThinkingStep[] | null
  taskStatus?: string
}

/**
 * ToolBlocksView Component
 *
 * Displays tool execution blocks separately from thinking timeline.
 * Extracts tools from thinking array and renders them as collapsible blocks.
 */
const ToolBlocksView = memo(function ToolBlocksView({ thinking, taskStatus }: ToolBlocksViewProps) {
  const { toolGroups, hasTools } = useToolExtraction(thinking)

  // Check if task is still running
  const isRunning = isRunningStatus(taskStatus)

  if (!hasTools) {
    return null
  }

  return (
    <div className="w-full mb-3" data-tool-blocks>
      {toolGroups.map(group => {
        const shouldExpand = isRunning || !group.isComplete
        return (
          <ToolBlockGroup
            key={group.id}
            group={group}
            taskStatus={taskStatus}
            defaultExpanded={shouldExpand}
          />
        )
      })}
    </div>
  )
})

export default ToolBlocksView
