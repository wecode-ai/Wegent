// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Wand2, Expand, FileText, Check, MessageSquare, Send, X, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { useAIAssist } from './AIAssistContext'
import type { AIAssistAction } from './types'

/**
 * Toolbar button configuration
 */
interface ToolbarButton {
  id: AIAssistAction | 'sendToChat'
  icon: React.ReactNode
  labelKey: string
}

const TOOLBAR_BUTTONS: ToolbarButton[] = [
  { id: 'rewrite', icon: <Wand2 className="h-4 w-4" />, labelKey: 'rewrite' },
  { id: 'expand', icon: <Expand className="h-4 w-4" />, labelKey: 'expand' },
  { id: 'summarize', icon: <FileText className="h-4 w-4" />, labelKey: 'summarize' },
  { id: 'fix_grammar', icon: <Check className="h-4 w-4" />, labelKey: 'fixGrammar' },
  { id: 'custom', icon: <MessageSquare className="h-4 w-4" />, labelKey: 'custom' },
]

interface FloatingToolbarProps {
  /** Callback when send to chat is triggered */
  onSendToChat?: (text: string) => void
  /** Additional class name */
  className?: string
}

/**
 * Floating toolbar component that appears when text is selected in the editor.
 * Provides quick actions for AI-assisted editing.
 */
export function FloatingToolbar({ onSendToChat, className }: FloatingToolbarProps) {
  const { t } = useTranslation('knowledge')
  const { state, startOperation, setSelection } = useAIAssist()
  const { selection, status } = state

  const [isVisible, setIsVisible] = useState(false)
  const [showCustomInput, setShowCustomInput] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 })

  const toolbarRef = useRef<HTMLDivElement>(null)
  const customInputRef = useRef<HTMLInputElement>(null)
  const showTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Calculate toolbar position
  useEffect(() => {
    if (!selection) {
      // Clear any pending show timeout
      if (showTimeoutRef.current) {
        clearTimeout(showTimeoutRef.current)
        showTimeoutRef.current = null
      }
      setIsVisible(false)
      setShowCustomInput(false)
      setCustomPrompt('')
      return
    }

    // Delay showing the toolbar (300ms as per requirement)
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
    }

    showTimeoutRef.current = setTimeout(() => {
      const toolbarWidth = showCustomInput ? 320 : 280
      const toolbarHeight = showCustomInput ? 84 : 44
      const padding = 8

      let left = selection.position.left - toolbarWidth / 2
      let top = selection.position.top - toolbarHeight - padding

      // Keep toolbar within viewport bounds
      left = Math.max(padding, Math.min(left, window.innerWidth - toolbarWidth - padding))

      // If there's not enough space above, show below
      if (top < padding) {
        top = selection.position.top + 24 + padding
      }

      setTooltipPosition({ top, left })
      setIsVisible(true)
    }, 300)

    return () => {
      if (showTimeoutRef.current) {
        clearTimeout(showTimeoutRef.current)
      }
    }
  }, [selection, showCustomInput])

  // Focus custom input when shown
  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus()
    }
  }, [showCustomInput])

  // Handle button click
  const handleButtonClick = useCallback(
    (actionId: AIAssistAction | 'sendToChat') => {
      if (!selection) return

      if (actionId === 'sendToChat') {
        onSendToChat?.(selection.text)
        setSelection(null)
        return
      }

      if (actionId === 'custom') {
        setShowCustomInput(true)
        return
      }

      startOperation(actionId)
    },
    [selection, onSendToChat, setSelection, startOperation]
  )

  // Handle custom prompt submit
  const handleCustomSubmit = useCallback(() => {
    if (!customPrompt.trim() || !selection) return

    startOperation('custom', customPrompt.trim())
    setShowCustomInput(false)
    setCustomPrompt('')
  }, [customPrompt, selection, startOperation])

  // Handle custom input key down
  const handleCustomKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleCustomSubmit()
      } else if (e.key === 'Escape') {
        setShowCustomInput(false)
        setCustomPrompt('')
      }
    },
    [handleCustomSubmit]
  )

  // Handle cancel custom input
  const handleCancelCustom = useCallback(() => {
    setShowCustomInput(false)
    setCustomPrompt('')
  }, [])

  // Don't render if not visible or no selection or if there's an active operation
  if (!isVisible || !selection || status !== 'idle') {
    return null
  }

  return createPortal(
    <div
      ref={toolbarRef}
      data-ai-assist-toolbar
      className={cn(
        'fixed z-[9999] animate-in fade-in-0 zoom-in-95 duration-150',
        className
      )}
      style={{
        top: tooltipPosition.top,
        left: tooltipPosition.left,
      }}
    >
      <div className="flex flex-col bg-surface border border-border rounded-lg shadow-md overflow-hidden">
        {/* Main toolbar buttons */}
        <div className="flex items-center gap-1 p-1">
          {TOOLBAR_BUTTONS.map((button) => (
            <Tooltip key={button.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleButtonClick(button.id)}
                  className={cn(
                    'h-8 w-8 p-0',
                    button.id === 'custom' && showCustomInput && 'bg-primary/10'
                  )}
                >
                  {button.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t(`aiAssist.toolbar.${button.labelKey}`)}
              </TooltipContent>
            </Tooltip>
          ))}
          {/* Send to chat button - only show when handler is provided */}
          {onSendToChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleButtonClick('sendToChat')}
                  className="h-8 w-8 p-0"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('aiAssist.toolbar.sendToChat')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Custom prompt input */}
        {showCustomInput && (
          <div className="flex items-center gap-2 px-2 pb-2 pt-1 border-t border-border">
            <Input
              ref={customInputRef}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              onKeyDown={handleCustomKeyDown}
              placeholder={t('aiAssist.customPrompt.placeholder')}
              className="h-8 text-sm flex-1"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelCustom}
              className="h-8 w-8 p-0 text-text-muted hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              onClick={handleCustomSubmit}
              disabled={!customPrompt.trim()}
              className="h-8 px-2"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export default FloatingToolbar
