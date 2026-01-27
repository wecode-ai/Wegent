// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetStreamingBridge component
 *
 * Bridges the ChatStreamContext and PetContext to update pet animation
 * based on AI streaming state. When any AI message is streaming,
 * the pet shows a "busy" animation.
 *
 * This component must be placed inside ChatStreamProvider but can access
 * PetContext from the parent PetProvider.
 */

import { useEffect } from 'react'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { usePet } from '@/features/pet/contexts/PetContext'

export function PetStreamingBridge() {
  const { getStreamingTaskIds } = useChatStreamContext()
  const { setAnimationState, animationState } = usePet()

  // Get current streaming task IDs
  const streamingTaskIds = getStreamingTaskIds()
  const isAnyStreaming = streamingTaskIds.length > 0

  useEffect(() => {
    // Only update animation state if it's currently 'idle' or 'busy'
    // Don't interrupt 'evolving' or 'gaining_exp' animations
    if (animationState === 'idle' || animationState === 'busy') {
      if (isAnyStreaming) {
        setAnimationState('busy')
      } else {
        setAnimationState('idle')
      }
    }
  }, [isAnyStreaming, animationState, setAnimationState])

  // This component doesn't render anything
  return null
}
