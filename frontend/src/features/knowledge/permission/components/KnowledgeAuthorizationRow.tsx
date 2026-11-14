// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Building2, Trash2, User, Users } from 'lucide-react'
import { KnowledgeMemberName } from '@extensions/knowledge-permissions'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole } from '@/types/knowledge'

export interface AuthorizationRow {
  key: string
  name: string
  type: string
  role: MemberRole | null
  source: 'creator' | 'inherited' | 'direct'
  memberId?: number
  inheritedType?: string
  inviterName?: string | null
}

export function KnowledgeAuthorizationRow({
  row,
  canManage,
  loading,
  onRole,
  onRemove,
}: {
  row: AuthorizationRow
  canManage: boolean
  loading: boolean
  onRole: (id: number, role: MemberRole) => void
  onRemove: (id: number) => void
}) {
  const { t } = useTranslation('knowledge')
  const text = 'document.authorizationObjects'
  const Icon = row.type === 'user' ? User : row.type === 'namespace' ? Users : Building2
  const type = ['user', 'namespace', 'organization'].includes(row.type) ? row.type : 'other'
  const editable = canManage && row.memberId !== undefined && row.role !== 'Owner'
  const label = row.role
    ? t(`document.navigation.permissionResult.${row.role}`)
    : t(`${text}.${row.inheritedType === 'organization' ? 'organizationRole' : 'groupRole'}`)
  return (
    <tr className="border-b border-border" data-testid="collaborator-item">
      <td className="min-w-32 px-3 py-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          <div className="min-w-0">
            <p className="break-words text-text-primary">
              {row.type === 'user' ? <KnowledgeMemberName name={row.name} /> : row.name}
            </p>
            <p className="text-xs text-text-muted">{t(`${text}.types.${type}`)}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        {editable ? (
          <Select
            value={row.role ?? undefined}
            disabled={loading}
            onValueChange={value => {
              if (row.memberId !== undefined) onRole(row.memberId, value as MemberRole)
            }}
          >
            <SelectTrigger
              className="min-h-11 min-w-28"
              data-testid={`permission-role-${row.memberId}`}
              aria-label={t(`${text}.objectPermission`, { name: row.name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE_ROLES.map(role => (
                <SelectItem key={role} value={role} className="min-h-11">
                  {t(`document.permission.role.${role}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          label
        )}
      </td>
      <td className="px-3 py-3 text-xs text-text-secondary">
        {t(`${text}.sources.${row.source}`)}
        {row.inviterName && (
          <p className="mt-1 text-xs text-text-muted">
            {t('document.permission.addedBy', { name: row.inviterName })}
          </p>
        )}
      </td>
      {canManage && (
        <td className="px-3 py-3 text-right">
          {editable ? (
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 text-error"
              data-testid={`permission-delete-${row.memberId}`}
              aria-label={t('document.permission.remove')}
              title={t('document.permission.remove')}
              disabled={loading}
              onClick={() => {
                if (row.memberId !== undefined && confirm(t('document.permission.confirmRemove')))
                  onRemove(row.memberId)
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : (
            <span className="text-xs text-text-muted">
              {t(
                `${text}.${
                  row.source !== 'inherited'
                    ? 'notRemovable'
                    : row.inheritedType === 'organization'
                      ? 'organizationPolicy'
                      : 'manageInGroups'
                }`
              )}
            </span>
          )}
        </td>
      )}
    </tr>
  )
}
