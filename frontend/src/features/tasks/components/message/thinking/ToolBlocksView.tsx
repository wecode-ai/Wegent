// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import type { ThinkingStep } from './types'
import { useToolExtraction } from './hooks/useToolExtraction'
import { ToolBlock } from './components/ToolBlock'
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
const ToolBlocksView = memo(function ToolBlocksView({ thinking }: ToolBlocksViewProps) {
  const { toolGroups, hasTools } = useToolExtraction(thinking)

  if (!hasTools) {
    return null
  }

  return (
    <div className="w-full mb-3" data-tool-blocks>
      {toolGroups.map(group => {
        // Single tool - render as ToolBlock (collapsed by default)
        if (group.tools.length === 1) {
          return <ToolBlock key={group.id} tool={group.tools[0]} defaultExpanded={false} />
        }

        // Multiple tools - render as ToolBlockGroup (group expanded, but tools inside collapsed)
        return <ToolBlockGroup key={group.id} group={group} defaultExpanded={true} />
      })}
    </div>
  )
})

export default ToolBlocksView
