// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import type { ThinkingDisplayProps } from './types'
import SimpleThinkingView from './SimpleThinkingView'
import DetailedThinkingView from './DetailedThinkingView'

/**
 * Main thinking display component that routes to the appropriate view
 * based on the shell type.
 *
 * - Chat shell type: Uses SimpleThinkingView (collapsible timeline)
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

  // Route to appropriate view based on shell type
  if (shellType === 'Chat') {
    return <SimpleThinkingView thinking={thinking} taskStatus={taskStatus} />
  }

  // Default to detailed view for ClaudeCode, Agno, and other shell types
  return <DetailedThinkingView thinking={thinking} taskStatus={taskStatus} />
})

export default ThinkingDisplay
