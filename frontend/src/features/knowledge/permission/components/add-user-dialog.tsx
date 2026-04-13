// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, FormEvent } from 'react'
import { UserPlus, XCircle } from 'lucide-react'
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
import type { MemberRole, BatchPermissionAddResponse } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'

/** Maximum number of users that can be added in a single batch */
const MAX_BATCH_SIZE = 10

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
  const [batchResult, setBatchResult] = useState<BatchPermissionAddResponse | null>(null)

  const { batchAddPermission, loading, error } = useKnowledgePermissions({ kbId })

  // Build a user_id -> user_name map from selectedUsers for result display
  const userNameMap = new Map(selectedUsers.map(u => [u.id, u.user_name]))

  const handleSelectedUsersChange = (users: SearchUser[]) => {
    if (users.length > MAX_BATCH_SIZE) {
      setLocalError(t('document.permission.maxUsersExceeded', { max: MAX_BATCH_SIZE }))
      return
    }
    // Clear errors when user changes selection
    setLocalError(null)
    setBatchResult(null)
    setSelectedUsers(users)
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setLocalError(null)
    setBatchResult(null)

    if (selectedUsers.length === 0) {
      setLocalError(t('document.permission.selectUser'))
      return
    }

    const validUsers = selectedUsers.filter(u => u.user_name.trim())
    if (validUsers.length === 0) {
      setLocalError(t('document.permission.invalidUserName'))
      return
    }

    if (validUsers.length > MAX_BATCH_SIZE) {
      setLocalError(t('document.permission.maxUsersExceeded', { max: MAX_BATCH_SIZE }))
      return
    }

    try {
      const members = validUsers.map(u => ({ user_id: u.id, role }))
      const result = await batchAddPermission(members)

      if (result.failed.length === 0) {
        // All succeeded — close dialog and reset
        onSuccess?.()
        onOpenChange(false)
        resetForm()
      } else {
        // Partial or full failure — show result details, keep dialog open
        setBatchResult(result)
      }
    } catch (_err) {
      // Network/server error is displayed from hook via `error` state
    }
  }

  const resetForm = () => {
    setSelectedUsers([])
    setRole('Reporter')
    setLocalError(null)
    setBatchResult(null)
  }

  const handleClose = () => {
    resetForm()
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
          onSelectedUsersChange={handleSelectedUsersChange}
          onRoleChange={setRole}
          onSubmit={handleSubmit}
          error={displayError}
        />

        {/* Batch result details — shown when partial failure occurs */}
        {batchResult && batchResult.failed.length > 0 && (
          <div className="text-sm text-error bg-error/10 px-3 py-2 rounded-lg space-y-1">
            {batchResult.failed.map(f => (
              <div key={f.user_id} className="flex items-center gap-1.5">
                <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>
                  {userNameMap.get(f.user_id) || `User ${f.user_id}`}{' '}
                  {t('document.permission.batchAddFailed')}: {f.error}
                </span>
              </div>
            ))}
          </div>
        )}

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
