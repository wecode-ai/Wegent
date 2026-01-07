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
import { deleteGroup } from '@/apis/groups'
import { toast } from 'sonner'
import type { Group } from '@/types/group'

interface DeleteGroupConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  group: Group | null
}

export function DeleteGroupConfirmDialog({
  isOpen,
  onClose,
  onSuccess,
  group,
}: DeleteGroupConfirmDialogProps) {
  const { t } = useTranslation()
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirm = async () => {
    if (!group) return

    // Check for blocking conditions
    if ((group.resource_count || 0) > 0) {
      toast.error(t('groups:groups.messages.cannotDeleteWithResources'))
      return
    }

    setIsDeleting(true)
    try {
      await deleteGroup(group.name)
      toast.success(t('groups:groups.messages.deleteSuccess'))
      onSuccess()
      onClose()
    } catch (error: unknown) {
      console.error('Failed to delete group:', error)
      const err = error as { response?: { data?: { detail?: string } }; message?: string }
      const errorMessage =
        err?.response?.data?.detail || err?.message || t('groups:groups.messages.deleteFailed')
      toast.error(errorMessage)
    } finally {
      setIsDeleting(false)
    }
  }

  if (!group) {
    return null
  }

  const hasBlockers = (group.resource_count || 0) > 0

  return (
    <AlertDialog open={isOpen} onOpenChange={open => !open && !isDeleting && onClose()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('groups:groups.actions.delete')}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>{t('groups:groups.messages.confirmDelete', { name: group.name })}</p>

            {hasBlockers && (
              <div className="bg-error/10 border border-error/20 text-error px-3 py-2 rounded-md text-sm">
                <p className="font-medium">{t('groups:groups.messages.cannotDelete')}</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  {(group.resource_count || 0) > 0 && (
                    <li>
                      {t('groups:groups.messages.hasResources', { count: group.resource_count })}
                    </li>
                  )}
                </ul>
                <p className="mt-2">{t('groups:groups.messages.removeResourcesFirst')}</p>
              </div>
            )}

            {!hasBlockers && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 rounded-md text-sm">
                <p className="font-medium">{t('common:common.warning')}:</p>
                <p className="mt-1">{t('common:common.cannotUndo')}</p>
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose} disabled={isDeleting}>
            {t('common:actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={hasBlockers || isDeleting}
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
                {t('common:actions.deleting')}
              </div>
            ) : (
              t('common:actions.delete')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
