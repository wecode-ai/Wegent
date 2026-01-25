// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { PenLine, List, Search, Command, ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { useAIAssist } from './AIAssistContext'
import type { CommandSuggestion } from './types'

/**
 * Default command suggestions
 */
const DEFAULT_SUGGESTIONS: CommandSuggestion[] = [
  {
    id: 'continue',
    label: 'continueWriting',
    action: 'continue',
    icon: 'PenLine',
  },
  {
    id: 'outline',
    label: 'generateOutline',
    action: 'outline',
    icon: 'List',
  },
  {
    id: 'search',
    label: 'searchAndExpand',
    action: 'search',
    icon: 'Search',
  },
]

/**
 * Icon mapping for suggestions
 */
const ICONS: Record<string, React.ReactNode> = {
  PenLine: <PenLine className="h-4 w-4" />,
  List: <List className="h-4 w-4" />,
  Search: <Search className="h-4 w-4" />,
}

interface CommandPaletteProps {
  /** Whether the palette is open */
  open: boolean
  /** Callback when palette should close */
  onClose: () => void
  /** Position to show the palette */
  position?: { top: number; left: number }
  /** Additional class name */
  className?: string
}

/**
 * Command palette component for quick AI generation.
 * Triggered by Ctrl+K / Cmd+K shortcut.
 */
export function CommandPalette({ open, onClose, position, className }: CommandPaletteProps) {
  const { t } = useTranslation('knowledge')
  const { startOperation } = useAIAssist()

  const [inputValue, setInputValue] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [palettePosition, setPalettePosition] = useState({ top: 0, left: 0 })

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Filter suggestions based on input - wrapped in useMemo to avoid deps warning
  const filteredSuggestions = useMemo(() => {
    return inputValue.trim() ? [] : DEFAULT_SUGGESTIONS
  }, [inputValue])

  // Calculate palette position
  useEffect(() => {
    if (!open) return

    if (position) {
      // Position relative to cursor
      const paletteWidth = 400
      const paletteHeight = 200

      let left = position.left - paletteWidth / 2
      let top = position.top + 20

      // Keep within viewport
      left = Math.max(16, Math.min(left, window.innerWidth - paletteWidth - 16))
      top = Math.max(16, Math.min(top, window.innerHeight - paletteHeight - 16))

      setPalettePosition({ top, left })
    } else {
      // Center in viewport
      setPalettePosition({
        top: window.innerHeight / 3,
        left: window.innerWidth / 2 - 200,
      })
    }
  }, [open, position])

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  // Reset state when closed
  useEffect(() => {
    if (!open) {
      setInputValue('')
      setSelectedIndex(0)
    }
  }, [open])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) =>
          prev < filteredSuggestions.length - 1 ? prev + 1 : prev
        )
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()

        if (inputValue.trim()) {
          // Custom prompt
          startOperation('custom', inputValue.trim())
        } else if (filteredSuggestions[selectedIndex]) {
          // Selected suggestion
          startOperation(filteredSuggestions[selectedIndex].action)
        }

        onClose()
        return
      }
    },
    [filteredSuggestions, selectedIndex, inputValue, startOperation, onClose]
  )

  // Handle suggestion click
  const handleSuggestionClick = useCallback(
    (suggestion: CommandSuggestion) => {
      startOperation(suggestion.action)
      onClose()
    },
    [startOperation, onClose]
  )

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/20 backdrop-blur-sm animate-in fade-in-0 duration-150"
      onClick={handleBackdropClick}
    >
      <div
        ref={containerRef}
        className={cn(
          'fixed bg-surface border border-border rounded-xl shadow-xl overflow-hidden',
          'w-[400px] max-w-[calc(100vw-32px)]',
          'animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150',
          className
        )}
        style={{
          top: palettePosition.top,
          left: palettePosition.left,
        }}
      >
        {/* Input section */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
          <Command className="h-4 w-4 text-text-muted flex-shrink-0" />
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('aiAssist.commandPalette.placeholder')}
            className="border-0 shadow-none focus-visible:ring-0 px-0 h-auto text-sm"
          />
          {inputValue.trim() && (
            <button
              onClick={() => {
                startOperation('custom', inputValue.trim())
                onClose()
              }}
              className="flex-shrink-0 p-1.5 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Suggestions list */}
        {filteredSuggestions.length > 0 && (
          <div className="p-2 max-h-[300px] overflow-y-auto">
            {filteredSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                onClick={() => handleSuggestionClick(suggestion)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left',
                  'transition-colors text-sm',
                  index === selectedIndex
                    ? 'bg-primary/10 text-primary'
                    : 'text-text-primary hover:bg-fill-tert'
                )}
              >
                <span className="flex-shrink-0 text-text-muted">
                  {suggestion.icon && ICONS[suggestion.icon]}
                </span>
                <span className="flex-1">
                  {t(`aiAssist.commandPalette.${suggestion.label}`)}
                </span>
                {index === selectedIndex && (
                  <span className="text-xs text-text-muted">↵</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Empty state when typing */}
        {inputValue.trim() && filteredSuggestions.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            <p>{t('aiAssist.commandPalette.customPromptHint')}</p>
          </div>
        )}

        {/* Shortcut hint */}
        <div className="px-3 py-2 border-t border-border bg-fill-tert">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>{t('aiAssist.commandPalette.hintNavigate')}</span>
            <span>{t('aiAssist.commandPalette.hintSelect')}</span>
            <span>{t('aiAssist.commandPalette.hintClose')}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default CommandPalette
