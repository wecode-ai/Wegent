'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription conversation dialog component.
 * Displays a Subscription task's conversation in a dialog without navigating away from the Subscriptions page.
 */
import { useEffect, useState, useCallback } from 'react'
import { Bot, Loader2, MessageSquare, User, AlertCircle, ExternalLink } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'
import { taskApis } from '@/apis/tasks'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { cn } from '@/lib/utils'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'

interface SubscriptionConversationDialogProps {
  taskId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Renders a single message in the conversation.
 */
function ConversationMessage({
  subtask,
  theme,
}: {
  subtask: TaskDetailSubtask
  theme: 'light' | 'dark'
}) {
  // Backend returns role in uppercase (USER/ASSISTANT), compare case-insensitively
  const isUser = subtask.role?.toUpperCase() === 'USER'
  const rawValue = subtask.result?.value
  const content = isUser
    ? subtask.prompt || ''
    : (typeof rawValue === 'string' ? rawValue : '') || (subtask.result?.message as string) || ''
  // Parse timestamp - backend returns local time without timezone suffix
  const timestamp = subtask.created_at ? new Date(subtask.created_at) : null

  return (
    <div className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center',
          isUser
            ? 'bg-primary/10 text-primary'
            : 'bg-gradient-to-br from-primary/20 to-primary/5 ring-2 ring-surface'
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4 text-primary" />}
      </div>

      {/* Message content */}
      <div className={cn('flex-1 min-w-0', isUser ? 'text-right' : 'text-left')}>
        <div
          className={cn(
            'inline-block max-w-[85%] rounded-2xl px-4 py-2',
            isUser
              ? 'bg-primary text-white rounded-tr-sm'
              : 'bg-surface border border-border rounded-tl-sm'
          )}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap text-sm text-left">{content}</div>
          ) : (
            <div className="text-sm prose prose-sm max-w-none dark:prose-invert">
              <EnhancedMarkdown source={content as string} theme={theme} />
            </div>
          )}
        </div>
        {timestamp && (
          <div className="text-xs text-text-muted mt-1">
            {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  )
}

export function SubscriptionConversationDialog({
  taskId,
  open,
  onOpenChange,
}: SubscriptionConversationDialogProps) {
  const { t } = useTranslation('feed')
  const { theme } = useTheme()
  const router = useRouter()
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch task detail when dialog opens
  useEffect(() => {
    if (open && taskId) {
      setLoading(true)
      setError(null)
      taskApis
        .getTaskDetail(taskId)
        .then((detail: TaskDetail) => {
          setTaskDetail(detail)
        })
        .catch((err: Error) => {
          console.error('[SubscriptionConversationDialog] Failed to load task:', err)
          setError(err.message || t('common:errors.unknown'))
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [open, taskId, t])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setTaskDetail(null)
      setError(null)
    }
  }, [open])

  const handleOpenInChat = useCallback(() => {
    if (taskId) {
      router.push(`/chat?taskId=${taskId}`)
      onOpenChange(false)
    }
  }, [taskId, router, onOpenChange])

  // Sort subtasks by message_id
  const sortedSubtasks = taskDetail?.subtasks
    ? [...taskDetail.subtasks].sort((a, b) => a.message_id - b.message_id)
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 max-w-[60%] leading-normal">
            <MessageSquare className="h-5 w-5 flex-shrink-0" />
            <span className="truncate">{taskDetail?.title || t('feed.view_conversation')}</span>
          </DialogTitle>
          <DialogDescription>
            {taskDetail?.team?.name && (
              <span className="text-text-muted">@{taskDetail.team.name}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto py-4 space-y-4 min-h-[300px]">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-text-muted">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span>{t('common:actions.loading')}</span>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
              <AlertCircle className="h-10 w-10 text-red-500" />
              <p className="text-sm text-red-600">{error}</p>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('common:actions.close')}
              </Button>
            </div>
          ) : sortedSubtasks.length === 0 ? (
            <div className="flex h-full items-center justify-center text-text-muted">
              <p>{t('feed.no_messages')}</p>
            </div>
          ) : (
            sortedSubtasks.map(subtask => (
              <ConversationMessage key={subtask.id} subtask={subtask} theme={theme} />
            ))
          )}
        </div>

        {/* Footer with action button */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
          {taskId && (
            <Button onClick={handleOpenInChat} className="gap-1.5">
              <ExternalLink className="h-4 w-4" />
              {t('feed.open_in_chat')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
