// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas editor component using a simple textarea.
 * Provides line numbers and basic editing functionality.
 */

'use client'

import React, { useRef, useEffect, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface CanvasEditorProps {
  content: string
  onChange: (content: string) => void
  readOnly?: boolean
  className?: string
}

export function CanvasEditor({ content, onChange, readOnly = false, className }: CanvasEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lineNumbersRef = useRef<HTMLDivElement>(null)
  const [lineCount, setLineCount] = useState(1)

  // Update line count when content changes
  useEffect(() => {
    const lines = content.split('\n').length
    setLineCount(Math.max(lines, 1))
  }, [content])

  // Sync scroll between textarea and line numbers
  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  // Handle tab key for indentation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab' && !readOnly) {
        e.preventDefault()
        const textarea = textareaRef.current
        if (!textarea) return

        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const value = textarea.value

        // Insert tab at cursor position
        const newValue = value.substring(0, start) + '  ' + value.substring(end)
        onChange(newValue)

        // Move cursor after the inserted tab
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2
        })
      }
    },
    [onChange, readOnly]
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value)
    },
    [onChange]
  )

  // Generate line numbers
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1)

  return (
    <div className={cn('flex h-full w-full overflow-hidden bg-surface rounded-lg border', className)}>
      {/* Line numbers column */}
      <div
        ref={lineNumbersRef}
        className="flex-shrink-0 w-12 bg-bg-muted overflow-hidden select-none border-r"
        style={{ overflowY: 'hidden' }}
      >
        <div className="py-3 px-2 text-right">
          {lineNumbers.map(num => (
            <div
              key={num}
              className="text-xs text-text-muted leading-6 font-mono"
              style={{ height: '24px' }}
            >
              {num}
            </div>
          ))}
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-hidden">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          readOnly={readOnly}
          className={cn(
            'w-full h-full resize-none outline-none bg-transparent',
            'py-3 px-4 text-sm font-mono leading-6',
            'text-text-primary placeholder:text-text-muted',
            readOnly && 'cursor-default'
          )}
          style={{
            minHeight: '100%',
            lineHeight: '24px',
          }}
          placeholder="Start typing..."
          spellCheck={false}
        />
      </div>
    </div>
  )
}
