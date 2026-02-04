// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import type { ThinkingDisplayProps } from './types'
import DetailedThinkingView from './DetailedThinkingView'
import ToolBlocksView from './ToolBlocksView'

/**
 * Check if thinking contains text-type steps (used by deep research)
 * These require DetailedThinkingView to render properly
 */
function hasTextTypeSteps(thinking: ThinkingDisplayProps['thinking']): boolean {
  if (!thinking || thinking.length === 0) return false
  return thinking.some(step => step.details?.type === 'text')
}

/**
 * Main thinking display component that routes to the appropriate view
 * based on the shell type.
 *
 * - Chat shell type: Only shows ToolBlocksView (no detailed timeline)
 *   - Exception: Shows DetailedThinkingView if thinking contains deep_research steps
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

  // Chat shell: Show detailed view for text-type steps (e.g. deep research), otherwise show tool blocks
  if (shellType === 'Chat') {
    // If thinking contains text-type steps, show detailed view
    if (hasTextTypeSteps(thinking)) {
      return <DetailedThinkingView thinking={thinking} taskStatus={taskStatus} />
    }
    return <ToolBlocksView thinking={thinking} taskStatus={taskStatus} />
  }

  // Default to detailed view for ClaudeCode, Agno, and other shell types
  return <DetailedThinkingView thinking={thinking} taskStatus={taskStatus} />
})

export default ThinkingDisplay
