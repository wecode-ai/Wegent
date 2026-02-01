// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useKnowledgePermissions } from '../hooks/useKnowledgePermissions'
import type { PermissionLevel } from '@/types/knowledge'

interface AddUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
}

export function AddUserDialog({
  open,
  onOpenChange,
  kbId,
  onSuccess,
}: AddUserDialogProps) {
  const { t } = useTranslation('knowledge')
  const [userId, setUserId] = useState('')
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>('view')
  const [localError, setLocalError] = useState<string | null>(null)

  const { addPermission, loading, error } = useKnowledgePermissions({ kbId })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    const parsedUserId = parseInt(userId, 10)
    if (isNaN(parsedUserId) || parsedUserId <= 0) {
      setLocalError(t('permission.invalidUserId'))
      return
    }

    try {
      await addPermission(parsedUserId, permissionLevel)
      onSuccess?.()
      onOpenChange(false)
      // Reset form
      setUserId('')
      setPermissionLevel('view')
    } catch (_err) {
      // Error is displayed from the hook
    }
  }

  const handleClose = () => {
    setUserId('')
    setPermissionLevel('view')
    setLocalError(null)
    onOpenChange(false)
  }

  const displayError = localError || error

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5" />
            {t('permission.addUser')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* User ID Input */}
            <div className="space-y-2">
              <Label htmlFor="userId">{t('permission.userId')}</Label>
              <Input
                id="userId"
                type="number"
                min="1"
                placeholder={t('permission.enterUserId')}
                value={userId}
                onChange={e => setUserId(e.target.value)}
                required
              />
            </div>

            {/* Permission Level Select */}
            <div className="space-y-2">
              <Label htmlFor="permissionLevel">{t('permission.permissionLevel')}</Label>
              <Select
                value={permissionLevel}
                onValueChange={v => setPermissionLevel(v as PermissionLevel)}
              >
                <SelectTrigger id="permissionLevel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">
                    <div>
                      <div className="font-medium">{t('permission.view')}</div>
                      <div className="text-xs text-text-muted">
                        {t('permission.viewDescription')}
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem value="edit">
                    <div>
                      <div className="font-medium">{t('permission.edit')}</div>
                      <div className="text-xs text-text-muted">
                        {t('permission.editDescription')}
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem value="manage">
                    <div>
                      <div className="font-medium">{t('permission.manage')}</div>
                      <div className="text-xs text-text-muted">
                        {t('permission.manageDescription')}
                      </div>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Error Message */}
            {displayError && (
              <div className="text-sm text-error bg-error/10 px-3 py-2 rounded-lg">
                {displayError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? <Spinner className="w-4 h-4" /> : t('permission.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
