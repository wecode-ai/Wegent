// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import type { ThinkingDisplayProps } from './types'
import DetailedThinkingView from './DetailedThinkingView'
import ToolBlocksView from './ToolBlocksView'

/**
 * Main thinking display component that routes to the appropriate view
 * based on the shell type.
 *
 * - Chat shell type: Only shows ToolBlocksView (no detailed timeline)
 * - ClaudeCode/Agno/Other: Uses DetailedThinkingView (full thinking process)
 */
const ThinkingDisplay = memo(function ThinkingDisplay({
  thinking,
  taskStatus,
  shellType,
}: ThinkingDisplayProps) {
  // Early return if no thinking data
  if (!thinking || thinking.length === 0) {
    return null
  }

  // Chat shell: Only show tool blocks
  if (shellType === 'Chat') {
    return <ToolBlocksView thinking={thinking} taskStatus={taskStatus} />
  }

  // Default to detailed view for ClaudeCode, Agno, and other shell types
  return <DetailedThinkingView thinking={thinking} taskStatus={taskStatus} />
})

export default ThinkingDisplay
