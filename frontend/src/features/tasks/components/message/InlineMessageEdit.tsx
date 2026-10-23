// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { Loader2, MessageSquareText, X } from 'lucide-react'
import MentionAutocomplete, {
  type MentionMenuAnchor,
  taskMentionName,
} from '@/features/tasks/components/chat/MentionAutocomplete'
import type { Task } from '@/types/api'

export interface InlineConversationRef {
  task_id: number
  name: string
  task_updated_at?: string
}

function conversationRefsKey(refs: InlineConversationRef[]): string {
  return refs
    .map(ref => ref.task_id)
    .sort((left, right) => left - right)
    .join(',')
}

export interface InlineMessageEditProps {
  initialContent: string
  onSave: (content: string, refs?: InlineConversationRef[]) => Promise<void>
  onCancel: () => void
  /** Previous tasks available from the @ menu for context handoff. */
  mentionTasks?: Task[]
  currentTaskId?: number | null
  enableTaskMentions?: boolean
  /** Conversation references already attached to the message being edited. */
  initialConversationRefs?: InlineConversationRef[]
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
  mentionTasks = [],
  currentTaskId,
  enableTaskMentions = false,
  initialConversationRefs = [],
}) => {
  const { t } = useTranslation()
  const [content, setContent] = useState(initialContent)
  const [isSaving, setIsSaving] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [conversationRefs, setConversationRefs] =
    useState<InlineConversationRef[]>(initialConversationRefs)
  const [mentionMenuState, setMentionMenuState] = useState<MentionMenuAnchor | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')

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

  // Actual save logic after user confirms
  const performSave = useCallback(async () => {
    const trimmedContent = content.trim()
    setIsSaving(true)
    try {
      await onSave(trimmedContent, conversationRefs)
    } catch (error) {
      console.error('Failed to save message:', error)
    } finally {
      setIsSaving(false)
      setShowConfirmDialog(false)
    }
  }, [content, conversationRefs, onSave])

  const handleConversationSelect = useCallback((task: Task) => {
    setContent(current => {
      const lastAtIndex = current.lastIndexOf('@')
      if (lastAtIndex === -1) return current
      const textAfterAt = current.substring(lastAtIndex + 1)
      const wordEndMatch = textAfterAt.match(/^\S*/)
      const currentWord = wordEndMatch ? wordEndMatch[0] : ''
      const textAfterWord = textAfterAt.substring(currentWord.length)
      return (current.substring(0, lastAtIndex) + textAfterWord).trimEnd()
    })
    setConversationRefs(previous => {
      if (previous.some(ref => ref.task_id === task.id)) return previous
      return [
        ...previous,
        {
          task_id: task.id,
          name: taskMentionName(task),
          task_updated_at: task.updated_at,
        },
      ]
    })
    setMentionMenuState(null)
    setMentionQuery('')
    textareaRef.current?.focus()
  }, [])

  const removeConversationRef = useCallback((taskId: number) => {
    setConversationRefs(previous => previous.filter(ref => ref.task_id !== taskId))
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = e.target.value
      setContent(nextValue)
      if (!enableTaskMentions) return
      const lastWord = nextValue.split(/\s+/).pop() ?? ''
      if (lastWord.startsWith('@')) {
        const textarea = textareaRef.current
        if (textarea) {
          const textareaRect = textarea.getBoundingClientRect()
          const containerRect = containerRef.current?.getBoundingClientRect() ?? textareaRect
          const direction =
            containerRect.top + containerRect.height / 2 < window.innerHeight / 2
              ? 'below'
              : 'above'
          setMentionMenuState({
            top: containerRect.top,
            bottom: containerRect.bottom,
            left: containerRect.left,
            direction,
          })
          setMentionQuery(lastWord.substring(1))
        }
      } else {
        setMentionMenuState(null)
        setMentionQuery('')
      }
    },
    [enableTaskMentions]
  )

  // Show confirmation dialog before saving
  const handleSave = useCallback(() => {
    const trimmedContent = content.trim()
    const changedReferences =
      conversationRefsKey(conversationRefs) !== conversationRefsKey(initialConversationRefs)
    if (!trimmedContent || (trimmedContent === initialContent.trim() && !changedReferences)) {
      onCancel()
      return
    }

    // Show confirmation dialog
    setShowConfirmDialog(true)
  }, [content, conversationRefs, initialContent, initialConversationRefs, onCancel])

  // Handle confirmation dialog cancel
  const handleConfirmCancel = useCallback(() => {
    setShowConfirmDialog(false)
  }, [])

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
    <div
      ref={containerRef}
      className="relative flex w-full flex-col rounded-3xl border border-primary/40 bg-base px-4 py-3 shadow-card-hover"
    >
      {conversationRefs.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {conversationRefs.map(ref => (
            <span
              key={ref.task_id}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1 text-xs text-text-primary"
              data-testid={`inline-conversation-ref-${ref.task_id}`}
            >
              <MessageSquareText className="h-3.5 w-3.5 text-text-secondary" />
              <span className="max-w-[200px] truncate">{ref.name}</span>
              <button
                type="button"
                onClick={() => removeConversationRef(ref.task_id)}
                aria-label={t('chat:mention.removeTaskReference', { name: ref.name })}
                className="flex h-11 w-11 items-center justify-center rounded text-text-muted hover:text-text-primary md:h-5 md:w-5"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={isSaving}
        className="min-h-[88px] w-full resize-none bg-transparent text-base leading-[26px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        placeholder={t('chat:placeholder.input')}
        data-testid="inline-message-edit-input"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={isSaving}
          data-testid="inline-message-edit-cancel-button"
        >
          {t('chat:actions.cancel') || 'Cancel'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={isSaving || !content.trim()}
          data-testid="inline-message-edit-save-button"
        >
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

      {enableTaskMentions && mentionMenuState && (
        <MentionAutocomplete
          team={null}
          query={mentionQuery}
          tasks={mentionTasks}
          currentTaskId={currentTaskId}
          enableTaskMentions
          onSelect={() => {}}
          onSelectTask={handleConversationSelect}
          onClose={() => setMentionMenuState(null)}
          position={mentionMenuState}
        />
      )}

      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat:edit.confirm_title') || 'Confirm Edit'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chat:edit.confirm_description') ||
                'This edit will clear this message and all subsequent messages. The conversation will restart from this point. Are you sure you want to continue?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleConfirmCancel} disabled={isSaving}>
              {t('chat:actions.cancel') || 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction onClick={performSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {t('chat:edit.confirming') || 'Processing...'}
                </>
              ) : (
                t('chat:edit.confirm_button') || 'Confirm'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default InlineMessageEdit
