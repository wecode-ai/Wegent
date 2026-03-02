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
import type { MemberRole } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'

interface AddUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
}

export function AddUserDialog({ open, onOpenChange, kbId, onSuccess }: AddUserDialogProps) {
  const { t } = useTranslation('knowledge')
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [localError, setLocalError] = useState<string | null>(null)

  const { addPermission, loading, error } = useKnowledgePermissions({ kbId })

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setLocalError(null)

    if (selectedUsers.length === 0) {
      setLocalError(t('document.permission.selectUser'))
      return
    }

    const userName = selectedUsers[0].user_name
    if (!userName.trim()) {
      setLocalError(t('document.permission.invalidUserName'))
      return
    }

    try {
      await addPermission(userName, role)
      onSuccess?.()
      onOpenChange(false)
      // Reset form
      setSelectedUsers([])
      setRole('Reporter')
    } catch (_err) {
      // Error is displayed from hook
    }
  }

  const handleClose = () => {
    setSelectedUsers([])
    setRole('Reporter')
    setLocalError(null)
    onOpenChange(false)
  }

  const handleAddClick = () => {
    handleSubmit()
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
          selectedUsers={selectedUsers}
          role={role}
          onSelectedUsersChange={setSelectedUsers}
          onRoleChange={setRole}
          onSubmit={handleSubmit}
          error={displayError}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={loading || selectedUsers.length === 0}
            onClick={handleAddClick}
          >
            {loading ? <Spinner className="w-4 h-4" /> : t('document.permission.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
