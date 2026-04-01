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

import React, { useState, useRef, useEffect, useCallback, useContext } from 'react'
import { X } from 'lucide-react'
import { usePet } from '@/features/pet/contexts/PetContext'
import { useTranslation } from '@/hooks/useTranslation'
import { PetAvatar } from './PetAvatar'
import { PetNotificationPanel } from './PetNotificationPanel'
import { ExpGainAnimation } from './ExpGainAnimation'
import { EvolutionAnimation } from './EvolutionAnimation'
import { ThinkingBubble } from './ThinkingBubble'
import { PromptDraftDialog } from '@/features/prompt-draft/components/PromptDraftDialog'
import { usePromptDraftHint } from '@/features/prompt-draft/hooks/usePromptDraftHint'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { TaskContext } from '@/features/tasks/contexts/taskContext'

const POSITION_STORAGE_KEY = 'pet-widget-position'
const DEFAULT_POSITION = { x: 16, y: 16 } // from bottom-right

interface Position {
  x: number
  y: number
}

export function PetWidget() {
  const { t } = useTranslation('pet')
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
  const [openPromptDraftDialog, setOpenPromptDraftDialog] = useState(false)
  const widgetRef = useRef<HTMLDivElement>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)
  const taskContext = useContext(TaskContext)
  const selectedTaskId = taskContext?.selectedTask?.id ?? null
  const showPromptHint = usePromptDraftHint(selectedTaskId)
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
      const target = e.target as HTMLElement
      if (target.closest('[data-pet-interactive="true"]')) return
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

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])

  const scheduleHoverClose = useCallback(() => {
    clearHoverCloseTimer()
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setIsHovered(false)
      hoverCloseTimerRef.current = null
    }, 180)
  }, [clearHoverCloseTimer])

  const handleWidgetMouseEnter = useCallback(() => {
    clearHoverCloseTimer()
    setIsHovered(true)
  }, [clearHoverCloseTimer])

  const handleWidgetMouseLeave = useCallback(() => {
    scheduleHoverClose()
  }, [scheduleHoverClose])

  useEffect(() => {
    return () => {
      clearHoverCloseTimer()
    }
  }, [clearHoverCloseTimer])

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
        onMouseEnter={handleWidgetMouseEnter}
        onMouseLeave={handleWidgetMouseLeave}
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
          {showPromptHint && (
            <div className="absolute -top-10 right-0 text-xs bg-surface border border-border rounded-md px-2 py-1 shadow-sm whitespace-nowrap">
              {taskContext ? t('promptDraft.hint') : ''}
            </div>
          )}
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
          <div
            data-pet-interactive="true"
            className="absolute bottom-full right-0 pb-2"
            onMouseEnter={handleWidgetMouseEnter}
            onMouseLeave={handleWidgetMouseLeave}
          >
            <PetNotificationPanel
              pet={pet}
              canGeneratePromptDraft={!!selectedTaskId}
              onOpenPromptDraft={() => setOpenPromptDraftDialog(true)}
            />
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

      <PromptDraftDialog
        open={openPromptDraftDialog}
        onOpenChange={setOpenPromptDraftDialog}
        taskId={selectedTaskId}
      />
    </>
  )
}
