// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * ExpGainAnimation component
 *
 * Shows floating "+X" text when pet gains experience.
 */

import React, { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface ExpGainAnimationProps {
  amount: number
  onComplete: () => void
}

export function ExpGainAnimation({ amount, onComplete }: ExpGainAnimationProps) {
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false)
      onComplete()
    }, 1500)

    return () => clearTimeout(timer)
  }, [onComplete])

  if (!isVisible) return null

  return (
    <div
      className={cn(
        'absolute -top-4 left-1/2 -translate-x-1/2',
        'text-primary font-bold text-sm',
        'animate-exp-float pointer-events-none'
      )}
    >
      +{amount}
    </div>
  )
}
