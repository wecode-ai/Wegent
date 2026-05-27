// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from '@/components/ui/select'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import { useTranslation } from '@/hooks/useTranslation'
import type { MemberRole } from '@/types/knowledge'
import { getRoleDisplayName, getRoleDescription } from '../utils'

interface RoleDropdownProps {
  value: MemberRole
  onValueChange: (role: MemberRole) => void
  disabled?: boolean
  showDelete?: boolean
  onDelete?: () => void
}

export function RoleDropdown({
  value,
  onValueChange,
  disabled,
  showDelete,
  onDelete,
}: RoleDropdownProps) {
  const { t } = useTranslation('knowledge')

  const handleValueChange = (v: string) => {
    if (v === '__delete__') {
      onDelete?.()
      return
    }
    onValueChange(v as MemberRole)
  }

  return (
    <Select value={value} onValueChange={handleValueChange} disabled={disabled}>
      <SelectTrigger className="w-[90px] h-7 text-xs" data-testid="role-select-trigger">
        <SelectValue>{getRoleDisplayName(value, t)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_ROLES.map(role => (
          <SelectItem key={role} value={role} className="py-1.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm">{getRoleDisplayName(role, t)}</span>
              <span className="text-[11px] text-text-muted leading-tight">
                {getRoleDescription(role, t)}
              </span>
            </div>
          </SelectItem>
        ))}
        {showDelete && (
          <>
            <SelectSeparator />
            <SelectItem
              value="__delete__"
              className="text-red-500 hover:text-red-600 hover:bg-red-50"
            >
              {t('document.permission.removeMember', { defaultValue: '移除成员' })}
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  )
}
