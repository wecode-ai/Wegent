// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, FormEvent } from 'react'
import { UserPlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useKnowledgePermissions } from '../hooks/useKnowledgePermissions'
import { AddUserForm } from './add-user-form'
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

  const handleSubmit = async (e: FormEvent) => {
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
      // Error is displayed from hook
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
        <AddUserForm
          userName={userName}
          permissionLevel={permissionLevel}
          onUserNameChange={setUserName}
          onPermissionLevelChange={setPermissionLevel}
          onSubmit={handleSubmit}
          error={displayError}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={loading}>
            {loading ? <Spinner className="w-4 h-4" /> : t('document.permission.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
