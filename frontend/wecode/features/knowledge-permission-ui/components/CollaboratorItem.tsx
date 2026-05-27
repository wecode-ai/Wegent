// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { User, Users, Building2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { hasPermission } from '@/types/base-role'
import type { MemberRole } from '@/types/knowledge'
import type { CollaboratorInfo } from '../types'
import { RoleDropdown } from './RoleDropdown'

const ENTITY_TYPE_ICONS = {
  user: User,
  namespace: Users,
  org_department: Building2,
} as const

interface CollaboratorItemProps {
  collaborator: CollaboratorInfo
  myRole: MemberRole | null
  onRoleChange: (id: number, role: MemberRole) => Promise<void>
  onRemove: (id: number) => Promise<void>
  loading: boolean
}

export function CollaboratorItem({
  collaborator,
  myRole,
  onRoleChange,
  onRemove,
  loading,
}: CollaboratorItemProps) {
  const { t } = useTranslation('knowledge')
  const canManage = hasPermission(myRole, 'Maintainer')
  const addedByName = collaborator.added_by_name || t('common:unknown', { defaultValue: '未知' })
  const Icon = ENTITY_TYPE_ICONS[collaborator.entity_type as keyof typeof ENTITY_TYPE_ICONS] || User

  const handleRoleChange = async (role: MemberRole) => {
    await onRoleChange(collaborator.id, role)
  }

  const handleRemove = async () => {
    await onRemove(collaborator.id)
  }

  return (
    <div
      className="flex items-center justify-between py-2 px-3 hover:bg-surface rounded-md transition-colors"
      data-testid="collaborator-item"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Icon className="w-4 h-4 text-text-muted flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-text-primary truncate">
              {collaborator.display_name}
              {collaborator.employee_id && (
                <span className="ml-1 text-[11px] text-text-muted">
                  ({collaborator.employee_id})
                </span>
              )}
            </span>
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {t('knowledge:document.permission.addedBy', { name: addedByName })}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 ml-4 flex-shrink-0">
        <RoleDropdown
          value={collaborator.role}
          onValueChange={handleRoleChange}
          disabled={!canManage || loading || collaborator.role === 'Owner'}
          showDelete={canManage && collaborator.role !== 'Owner'}
          onDelete={handleRemove}
        />
      </div>
    </div>
  )
}
