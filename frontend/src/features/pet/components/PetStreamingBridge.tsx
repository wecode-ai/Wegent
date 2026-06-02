// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetStreamingBridge component
 *
 * Bridges the TaskSessionContext and PetContext to update pet animation
 * based on AI streaming state. When any AI message is streaming,
 * the pet shows a "busy" animation.
 *
 * This component must be placed inside TaskSessionProvider but can access
 * PetContext from the parent PetProvider.
 */

import { useEffect } from 'react'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { usePet } from '@/features/pet/contexts/PetContext'

export function PetStreamingBridge() {
  const { isStreaming } = useTaskSession()
  const { setAnimationState, animationState } = usePet()

  useEffect(() => {
    // Only update animation state if it's currently 'idle' or 'busy'
    // Don't interrupt 'evolving' or 'gaining_exp' animations
    if (animationState === 'idle' || animationState === 'busy') {
      if (isStreaming) {
        setAnimationState('busy')
      } else {
        setAnimationState('idle')
      }
    }
  }, [isStreaming, animationState, setAnimationState])

  // This component doesn't render anything
  return null
}
