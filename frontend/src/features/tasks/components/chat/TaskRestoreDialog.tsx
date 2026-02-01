// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN, enUS } from 'date-fns/locale'
import { Clock, RefreshCw } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskExpiredInfo } from '@/utils/errorParser'

export interface TaskRestoreDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskInfo: TaskExpiredInfo | null
  pendingMessage: string
  onConfirmRestore: () => void
  onCancel: () => void
  isRestoring: boolean
}

/**
 * Dialog component for confirming task restoration
 *
 * Shown when a user tries to send a message to an expired task.
 * Displays the last active time and allows the user to restore the task.
 */
export function TaskRestoreDialog({
  open,
  onOpenChange,
  taskInfo,
  pendingMessage,
  onConfirmRestore,
  onCancel,
  isRestoring,
}: TaskRestoreDialogProps) {
  const { t, i18n } = useTranslation('chat')

  // Format the last active time as relative time
  const lastActiveText = useMemo(() => {
    if (!taskInfo?.lastUpdatedAt) return ''

    try {
      const lastUpdated = new Date(taskInfo.lastUpdatedAt)
      const locale = i18n.language === 'zh-CN' ? zhCN : enUS
      return formatDistanceToNow(lastUpdated, { addSuffix: true, locale })
    } catch {
      return taskInfo.lastUpdatedAt
    }
  }, [taskInfo?.lastUpdatedAt, i18n.language])

  const handleCancel = useCallback(() => {
    onCancel()
    onOpenChange(false)
  }, [onCancel, onOpenChange])

  const handleConfirm = useCallback(() => {
    onConfirmRestore()
  }, [onConfirmRestore])

  if (!taskInfo) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" />
            {t('restore.dialog_title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>{t('restore.dialog_description')}</p>
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <span>{t('restore.last_active', { time: lastActiveText })}</span>
              </div>
              {pendingMessage && (
                <div className="mt-2 p-3 bg-surface rounded-md border border-border">
                  <p className="text-xs text-text-muted mb-1">
                    {t('restore.pending_message_label', { defaultValue: 'Your message:' })}
                  </p>
                  <p className="text-sm text-text-primary line-clamp-3">{pendingMessage}</p>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isRestoring}>
            {t('restore.cancel_button')}
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={isRestoring}>
            {isRestoring ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                {t('restore.restoring', { defaultValue: 'Restoring...' })}
              </>
            ) : (
              t('restore.confirm_button')
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
