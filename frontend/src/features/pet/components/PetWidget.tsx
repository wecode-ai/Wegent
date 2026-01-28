// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetWidget component
 *
 * Floating pet widget that appears in the bottom-right corner.
 * Shows pet avatar with animations and hover status.
 * Can be dragged (desktop) or fixed (mobile).
 * Shows thinking bubble when AI is generating output.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { usePet } from '@/features/pet/contexts/PetContext'
import { PetAvatar } from './PetAvatar'
import { PetNotificationPanel } from './PetNotificationPanel'
import { ExpGainAnimation } from './ExpGainAnimation'
import { EvolutionAnimation } from './EvolutionAnimation'
import { ThinkingBubble } from './ThinkingBubble'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { cn } from '@/lib/utils'

const POSITION_STORAGE_KEY = 'pet-widget-position'
const DEFAULT_POSITION = { x: 16, y: 16 } // from bottom-right

interface Position {
  x: number
  y: number
}

export function PetWidget() {
  const {
    pet,
    animationState,
    pendingExpGain,
    pendingEvolution,
    updatePet,
    clearPendingExpGain,
    clearPendingEvolution,
  } = usePet()
  const isMobile = useIsMobile()
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [position, setPosition] = useState<Position>(DEFAULT_POSITION)
  const widgetRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{
    mouseX: number
    mouseY: number
    posX: number
    posY: number
  } | null>(null)

  // Load saved position from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && !isMobile) {
      const saved = localStorage.getItem(POSITION_STORAGE_KEY)
      if (saved) {
        try {
          const parsed = JSON.parse(saved)
          setPosition(parsed)
        } catch {
          // Ignore invalid JSON
        }
      }
    }
  }, [isMobile])

  // Save position to localStorage
  const savePosition = useCallback((pos: Position) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(pos))
    }
  }, [])

  // Handle mouse down for dragging (desktop only)
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile) return
      e.preventDefault()
      setIsDragging(true)
      dragStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        posX: position.x,
        posY: position.y,
      }
    },
    [isMobile, position]
  )

  // Handle mouse move for dragging
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return

      const deltaX = dragStartRef.current.mouseX - e.clientX
      const deltaY = dragStartRef.current.mouseY - e.clientY

      const newX = Math.max(
        0,
        Math.min(window.innerWidth - 100, dragStartRef.current.posX + deltaX)
      )
      const newY = Math.max(
        0,
        Math.min(window.innerHeight - 100, dragStartRef.current.posY + deltaY)
      )

      setPosition({ x: newX, y: newY })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      savePosition(position)
      dragStartRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, position, savePosition])

  // Handle close button click
  const handleClose = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await updatePet({ is_visible: false })
      } catch {
        // Error handled in context
      }
    },
    [updatePet]
  )

  // Don't render if no pet, not visible, or on mobile
  if (!pet || !pet.is_visible || isMobile) {
    return null
  }

  return (
    <>
      {/* Main widget */}
      <div
        ref={widgetRef}
        className={cn(
          'fixed z-50 select-none',
          isDragging && 'cursor-grabbing',
          !isDragging && !isMobile && 'cursor-grab'
        )}
        style={{
          right: position.x,
          bottom: position.y,
        }}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Close button */}
        <button
          type="button"
          aria-label="Close pet widget"
          onMouseDown={e => e.stopPropagation()}
          onClick={handleClose}
          className={cn(
            'absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-surface border border-border',
            'flex items-center justify-center text-text-secondary hover:text-text-primary',
            'transition-opacity duration-200 shadow-sm',
            isHovered ? 'opacity-100' : 'opacity-0'
          )}
        >
          <X className="w-3 h-3" />
        </button>

        {/* Pet avatar */}
        <div className="relative">
          <PetAvatar pet={pet} animationState={animationState} isMobile={isMobile} />

          {/* Thinking bubble when AI is generating */}
          {animationState === 'busy' && <ThinkingBubble />}

          {/* Experience gain animation */}
          {pendingExpGain && (
            <ExpGainAnimation amount={pendingExpGain.amount} onComplete={clearPendingExpGain} />
          )}
        </div>

        {/* Notification panel on hover */}
        {isHovered && !isDragging && (
          <div className="absolute bottom-full right-0 mb-2">
            <PetNotificationPanel pet={pet} />
          </div>
        )}
      </div>

      {/* Evolution animation overlay */}
      {pendingEvolution && (
        <EvolutionAnimation
          oldStage={pendingEvolution.old_stage}
          newStage={pendingEvolution.new_stage}
          onComplete={clearPendingEvolution}
        />
      )}
    </>
  )
}
