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
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useKnowledgeGrants } from '../hooks/useKnowledgeGrants'
import client from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { AddUserForm } from './add-user-form'
import type { MemberRole } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'

/** Maximum number of users that can be added in a single batch */
const MAX_BATCH_SIZE = 10

interface AddUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
  onChanged?: () => void
  onAccessDenied?: () => void
}

export function AddUserDialog(props: AddUserDialogProps) {
  const { user } = useUser()
  return (
    <AddUserSession
      key={JSON.stringify([user?.id, client.getCacheScope(), props.kbId, props.open])}
      {...props}
    />
  )
}

function AddUserSession({
  open,
  onOpenChange,
  kbId,
  onSuccess,
  onChanged,
  onAccessDenied,
}: AddUserDialogProps) {
  const { t } = useTranslation('knowledge')
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [localError, setLocalError] = useState<string | null>(null)

  const { grant, loading, error, failures, uncertain } = useKnowledgeGrants({
    kbId,
    onChanged,
    onAccessDenied,
  })

  const handleSelectedUsersChange = (users: SearchUser[]) => {
    if (users.length > MAX_BATCH_SIZE) {
      setLocalError(t('document.permission.maxUsersExceeded', { max: MAX_BATCH_SIZE }))
      return
    }
    // Clear errors when user changes selection
    setLocalError(null)
    setSelectedUsers(users)
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setLocalError(null)

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
      const remaining = await grant(
        validUsers.map(u => ({
          id: 'user-' + u.id,
          entityType: 'user',
          entityId: String(u.id),
          label: u.user_name,
          role,
        }))
      )
      if (remaining === null) return
      setSelectedUsers(
        validUsers.filter(user => remaining.some(entry => entry.entityId === String(user.id)))
      )
      if (remaining.length === 0) {
        // All succeeded — close dialog and reset
        onSuccess?.()
        onOpenChange(false)
        resetForm()
      }
    } catch (_err) {
      // Network/server error is displayed from hook via `error` state
    }
  }

  const resetForm = () => {
    setSelectedUsers([])
    setRole('Reporter')
    setLocalError(null)
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  const handleAddClick = () => {
    handleSubmit()
  }

  const displayError = localError || (error ? t('document.creation.' + error) : null)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        closeButtonProps={{ className: 'min-h-11 min-w-11 flex items-center justify-center' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5" />
            {t('document.permission.addUser')}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>{t('document.creation.selectTargets')}</DialogDescription>
        <fieldset disabled={loading || uncertain}>
          <AddUserForm
            selectedUsers={selectedUsers}
            role={role}
            onSelectedUsersChange={handleSelectedUsersChange}
            onRoleChange={setRole}
            onSubmit={handleSubmit}
            error={displayError}
          />
        </fieldset>
        {/* Batch result details — shown when partial failure occurs */}
        {failures.length > 0 && (
          <div role="alert" className="text-sm text-error space-y-1">
            {failures.map(({ entry, error: reason }) => (
              <p key={entry.entityId}>
                {entry.label}:{' '}
                {['unconfirmed', 'roleConflict', 'notSubmitted'].includes(reason)
                  ? t('document.creation.' + reason)
                  : reason}
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11"
            onClick={handleClose}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-11 min-w-11"
            disabled={loading || selectedUsers.length === 0}
            data-testid="submit-user-permissions"
            onClick={handleAddClick}
          >
            {loading ? (
              <Spinner className="w-4 h-4" />
            ) : (
              t(
                uncertain
                  ? 'document.creation.verifyAndRetry'
                  : failures.length
                    ? 'document.creation.retryFailed'
                    : 'document.permission.add'
              )
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
