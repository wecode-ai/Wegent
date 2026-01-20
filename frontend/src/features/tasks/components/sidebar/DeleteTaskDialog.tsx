// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
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
import { taskApis } from '@/apis/tasks'
import { toast } from 'sonner'
import type { Task } from '@/types/api'

interface DeleteTaskDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  task: Task | null
  isGroupChat?: boolean
}

export function DeleteTaskDialog({
  isOpen,
  onClose,
  onSuccess,
  task,
  isGroupChat = false,
}: DeleteTaskDialogProps) {
  const { t } = useTranslation('tasks')
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirm = async () => {
    if (!task) return

    setIsDeleting(true)
    try {
      await taskApis.deleteTask(task.id)
      toast.success(
        isGroupChat ? t('deleteConfirm.leaveSuccess') : t('deleteConfirm.deleteSuccess')
      )
      onSuccess()
      onClose()
    } catch (error: unknown) {
      console.error('Failed to delete task:', error)
      const err = error as { response?: { data?: { detail?: string } }; message?: string }
      const errorMessage =
        err?.response?.data?.detail ||
        err?.message ||
        (isGroupChat ? t('deleteConfirm.leaveFailed') : t('deleteConfirm.deleteFailed'))
      toast.error(errorMessage)
    } finally {
      setIsDeleting(false)
    }
  }

  if (!task) {
    return null
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={open => !open && !isDeleting && onClose()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isGroupChat ? t('deleteConfirm.leaveTitle') : t('deleteConfirm.title')}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>{isGroupChat ? t('deleteConfirm.leaveMessage') : t('deleteConfirm.message')}</p>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200 px-3 py-2 rounded-md text-sm">
              <p className="font-medium">{t('common:common.warning')}:</p>
              <p className="mt-1">{t('common:common.cannotUndo')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose} disabled={isDeleting}>
            {t('common:actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isDeleting}
            className="bg-error hover:bg-error/90 text-white"
          >
            {isDeleting ? (
              <div className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {isGroupChat ? t('deleteConfirm.leaving') : t('common:actions.deleting')}
              </div>
            ) : isGroupChat ? (
              t('common:groupChat.leave')
            ) : (
              t('common:actions.delete')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
