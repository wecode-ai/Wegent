// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

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
import { Loader2 } from 'lucide-react'

import { DeleteTarget } from './OutboundTokenAdminTypes'

type OutboundTokenDeleteDialogProps = {
  deleteTarget: DeleteTarget | null
  isDeleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

const OutboundTokenDeleteDialog: React.FC<OutboundTokenDeleteDialogProps> = ({
  deleteTarget,
  isDeleting,
  onOpenChange,
  onConfirm,
}) => {
  const { t } = useTranslation('admin')

  return (
    <AlertDialog open={!!deleteTarget} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('outbound_tokens.common.delete_confirm_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteTarget?.type === 'issuer'
              ? t('outbound_tokens.issuers.delete_confirm_message', {
                  name: deleteTarget.issuer.name,
                })
              : t('outbound_tokens.signing_keys.delete_confirm_message', {
                  name: deleteTarget?.key.name,
                })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={event => {
              event.preventDefault()
              onConfirm()
            }}
            disabled={isDeleting}
          >
            {isDeleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {t('common:actions.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default OutboundTokenDeleteDialog
