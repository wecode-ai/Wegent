// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

const MAX_TITLE_LENGTH = 100

interface TaskInlineRenameProps {
  taskId: number
  initialTitle: string
  isEditing: boolean
  onEditEnd: () => void
  onSave: (newTitle: string) => Promise<void>
  className?: string
}

/**
 * Shared inline rename component for task titles.
 * Supports editing with validation, keyboard navigation, and error handling.
 */
export function TaskInlineRename({
  initialTitle,
  isEditing,
  onEditEnd,
  onSave,
  className,
}: TaskInlineRenameProps) {
  const { t } = useTranslation('common')
  const [value, setValue] = useState(initialTitle)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus and select all text when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Reset value when initialTitle changes or when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setValue(initialTitle)
      setError(null)
    }
  }, [isEditing, initialTitle])

  const handleSave = useCallback(async () => {
    const trimmedValue = value.trim()

    // Validate empty
    if (!trimmedValue) {
      setError(t('tasks.rename_empty_error'))
      return
    }

    // If value unchanged, just exit
    if (trimmedValue === initialTitle) {
      onEditEnd()
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      await onSave(trimmedValue)
      onEditEnd()
    } catch (err) {
      console.error('[TaskInlineRename] Save failed:', err)
      setError(t('tasks.rename_save_error'))
    } finally {
      setIsSaving(false)
    }
  }, [value, initialTitle, onSave, onEditEnd, t])

  const handleCancel = useCallback(() => {
    setValue(initialTitle)
    setError(null)
    onEditEnd()
  }, [initialTitle, onEditEnd])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleCancel()
      }
    },
    [handleSave, handleCancel]
  )

  const handleBlur = useCallback(() => {
    // Only save if not already saving (to avoid double saves)
    if (!isSaving) {
      handleSave()
    }
  }, [handleSave, isSaving])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    // Enforce max length
    if (newValue.length <= MAX_TITLE_LENGTH) {
      setValue(newValue)
      setError(null)
    }
  }, [])

  // Prevent click events from bubbling (to avoid task selection/navigation)
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  if (!isEditing) {
    return null
  }

  return (
    <div className={cn('flex-1 min-w-0', className)} onClick={handleClick}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          disabled={isSaving}
          className={cn(
            'w-full px-1 py-0.5 text-sm bg-transparent rounded',
            'border-2 outline-none transition-colors',
            error ? 'border-red-500 focus:border-red-500' : 'border-primary focus:border-primary',
            isSaving && 'opacity-50 cursor-not-allowed'
          )}
          onClick={handleClick}
        />
        {/* Character counter */}
        <div
          className={cn(
            'absolute right-1 -bottom-4 text-xs',
            value.length > 90 ? 'text-amber-500' : 'text-text-muted'
          )}
        >
          {value.length}/{MAX_TITLE_LENGTH}
        </div>
      </div>
      {/* Error message */}
      {error && <div className="mt-4 text-xs text-red-500">{error}</div>}
    </div>
  )
}
