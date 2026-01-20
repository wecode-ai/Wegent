// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { taskApis } from '@/apis/tasks'
import { cn } from '@/lib/utils'

interface TaskInlineEditProps {
  taskId: number
  initialTitle: string
  onSave: (newTitle: string) => void
  onCancel: () => void
}

const MAX_TITLE_LENGTH = 100

export default function TaskInlineEdit({
  taskId,
  initialTitle,
  onSave,
  onCancel,
}: TaskInlineEditProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialTitle)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus and select all text on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [])

  const handleSave = useCallback(async () => {
    const trimmedValue = value.trim()

    // Validation: empty check
    if (!trimmedValue) {
      setError(t('common:tasks.rename_empty_error'))
      return
    }

    // No change, just cancel
    if (trimmedValue === initialTitle.trim()) {
      onCancel()
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      await taskApis.updateTask(taskId, { title: trimmedValue })
      onSave(trimmedValue)
    } catch (err) {
      console.error('Failed to rename task:', err)
      setError(t('common:tasks.rename_save_error'))
      setIsSaving(false)
    }
  }, [value, initialTitle, taskId, onSave, onCancel, t])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()

    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    // Limit input to max length
    if (newValue.length <= MAX_TITLE_LENGTH) {
      setValue(newValue)
      setError(null)
    }
  }

  const handleBlur = () => {
    // Don't save on blur if already saving
    if (!isSaving) {
      handleSave()
    }
  }

  const currentLength = value.length
  const isNearLimit = currentLength > 90

  return (
    <div className="flex-1 min-w-0 relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onClick={e => e.stopPropagation()}
        disabled={isSaving}
        className={cn(
          'w-full text-sm text-text-primary leading-tight px-1.5 py-0.5 rounded',
          'border-2 outline-none transition-colors',
          'bg-transparent',
          error ? 'border-red-500' : 'border-primary',
          isSaving && 'opacity-60'
        )}
        style={{ margin: '-2px -6px', width: 'calc(100% + 12px)' }}
      />

      {/* Error message and character counter */}
      <div className="absolute left-0 right-0 -bottom-5 flex items-center justify-between px-1">
        {error && <span className="text-xs text-red-500 truncate mr-2">{error}</span>}
        <span
          className={cn('text-xs ml-auto', isNearLimit ? 'text-yellow-600' : 'text-text-muted')}
        >
          {currentLength}/{MAX_TITLE_LENGTH}
        </span>
      </div>
    </div>
  )
}
