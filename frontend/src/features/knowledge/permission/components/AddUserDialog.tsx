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

export function AddUserDialog({ open, onOpenChange, kbId, onSuccess }: AddUserDialogProps) {
  const { t } = useTranslation('knowledge')
  const [userName, setUserName] = useState('')
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>('view')
  const [localError, setLocalError] = useState<string | null>(null)

  const { addPermission, loading, error } = useKnowledgePermissions({ kbId })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    const trimmedUserName = userName.trim()
    if (!trimmedUserName) {
      setLocalError(t('document.permission.invalidUserName'))
      return
    }

    try {
      await addPermission(trimmedUserName, permissionLevel)
      onSuccess?.()
      onOpenChange(false)
      // Reset form
      setUserName('')
      setPermissionLevel('view')
    } catch (_err) {
      // Error is displayed from the hook
    }
  }

  const handleClose = () => {
    setUserName('')
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
            {t('document.permission.addUser')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* User Name Input */}
            <div className="space-y-2">
              <Label htmlFor="userName">{t('document.permission.userName')}</Label>
              <Input
                id="userName"
                type="text"
                placeholder={t('document.permission.enterUserName')}
                value={userName}
                onChange={e => setUserName(e.target.value)}
                required
              />
            </div>

            {/* Permission Level Select */}
            <div className="space-y-2">
              <Label htmlFor="permissionLevel">{t('document.permission.permissionLevel')}</Label>
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
                      <div className="font-medium">{t('document.permission.view')}</div>
                      <div className="text-xs text-text-muted">
                        {t('document.permission.viewDescription')}
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem value="edit">
                    <div>
                      <div className="font-medium">{t('document.permission.edit')}</div>
                      <div className="text-xs text-text-muted">
                        {t('document.permission.editDescription')}
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem value="manage">
                    <div>
                      <div className="font-medium">{t('document.permission.manage')}</div>
                      <div className="text-xs text-text-muted">
                        {t('document.permission.manageDescription')}
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
              {loading ? <Spinner className="w-4 h-4" /> : t('document.permission.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
