// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

export interface InlineMessageEditProps {
  initialContent: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
}

/**
 * Inline message edit component that replaces the message content
 * with an editable textarea. Supports:
 * - Multi-line input with auto-expanding height
 * - Save and Cancel buttons
 * - Keyboard shortcuts: Enter to save (without Shift), Escape to cancel
 * - Loading state during save
 */
const InlineMessageEdit: React.FC<InlineMessageEditProps> = ({
  initialContent,
  onSave,
  onCancel,
}) => {
  const { t } = useTranslation()
  const [content, setContent] = useState(initialContent)
  const [isSaving, setIsSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Focus textarea on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
      // Place cursor at the end
      textareaRef.current.selectionStart = textareaRef.current.value.length
      textareaRef.current.selectionEnd = textareaRef.current.value.length
    }
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [content])

  const handleSave = useCallback(async () => {
    const trimmedContent = content.trim()
    if (!trimmedContent || trimmedContent === initialContent.trim()) {
      onCancel()
      return
    }

    setIsSaving(true)
    try {
      await onSave(trimmedContent)
    } catch (error) {
      console.error('Failed to save message:', error)
    } finally {
      setIsSaving(false)
    }
  }, [content, initialContent, onSave, onCancel])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSave()
      }
    },
    [onCancel, handleSave]
  )

  return (
    <div className="flex flex-col gap-2 w-full">
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={e => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isSaving}
        className="min-h-[60px] resize-none bg-fill-sec border-border-muted focus:border-primary"
        placeholder={t('chat:placeholder.input')}
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          {t('chat:actions.cancel') || 'Cancel'}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={isSaving || !content.trim()}>
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              {t('chat:actions.save') || 'Save'}
            </>
          ) : (
            t('chat:actions.save') || 'Save'
          )}
        </Button>
      </div>
    </div>
  )
}

export default InlineMessageEdit
