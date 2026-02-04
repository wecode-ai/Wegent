// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FormEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import type { PermissionLevel } from '@/types/knowledge'

interface AddUserFormProps {
  userName: string
  permissionLevel: PermissionLevel
  onUserNameChange: (value: string) => void
  onPermissionLevelChange: (level: PermissionLevel) => void
  onSubmit: (e: FormEvent) => void
  error: string | null
}

export function AddUserForm({
  userName,
  permissionLevel,
  onUserNameChange,
  onPermissionLevelChange,
  onSubmit,
  error,
}: AddUserFormProps) {
  const { t } = useTranslation('knowledge')

  return (
    <form onSubmit={onSubmit}>
      <div className="space-y-4 py-4">
        {/* User Name Input */}
        <div className="space-y-2">
          <Label htmlFor="userName">{t('document.permission.userName')}</Label>
          <Input
            id="userName"
            type="text"
            placeholder={t('document.permission.enterUserName')}
            value={userName}
            onChange={e => onUserNameChange(e.target.value)}
            required
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
