// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Shield } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { CollaboratorList } from './CollaboratorList'

interface KnowledgePermissionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
}

export function KnowledgePermissionDialog({
  open,
  onOpenChange,
  kbId,
}: KnowledgePermissionDialogProps) {
  const { t } = useTranslation('knowledge')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="w-4 h-4" />
            {t('document.permission.permissionManagement')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-hidden min-h-0">
          <CollaboratorList kbId={kbId} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
