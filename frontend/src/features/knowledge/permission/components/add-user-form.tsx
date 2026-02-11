// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FormEvent } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import type { PermissionLevel } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'

interface AddUserFormProps {
  selectedUsers: SearchUser[]
  permissionLevel: PermissionLevel
  onSelectedUsersChange: (users: SearchUser[]) => void
  onPermissionLevelChange: (level: PermissionLevel) => void
  onSubmit: (e: FormEvent) => void
  error: string | null
}

export function AddUserForm({
  selectedUsers,
  permissionLevel,
  onSelectedUsersChange,
  onPermissionLevelChange,
  onSubmit,
  error,
}: AddUserFormProps) {
  const { t } = useTranslation('knowledge')

  return (
    <form onSubmit={onSubmit}>
      <div className="space-y-4 py-4">
        {/* User Search Select */}
        <div className="space-y-2">
          <Label>{t('document.permission.userName')}</Label>
          <UserSearchSelect
            selectedUsers={selectedUsers}
            onSelectedUsersChange={onSelectedUsersChange}
            placeholder={t('document.permission.searchUserPlaceholder')}
            multiple={false}
          />
        </div>

        {/* Permission Level Select */}
        <div className="space-y-2">
          <Label htmlFor="permissionLevel">{t('document.permission.permissionLevel')}</Label>
          <Select
            value={permissionLevel}
            onValueChange={v => onPermissionLevelChange(v as PermissionLevel)}
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
        {error && (
          <div className="text-sm text-error bg-error/10 px-3 py-2 rounded-lg">{error}</div>
        )}
      </div>
    </form>
  )
}
