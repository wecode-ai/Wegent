// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, Clock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole, PendingPermissionInfo } from '@/types/knowledge'

export function PermissionRequests({
  pending,
  loading,
  onReview,
  roles,
  onRoleChange,
}: {
  roles: Record<number, MemberRole>
  onRoleChange: (id: number, role: MemberRole) => void
  pending: PendingPermissionInfo[]
  loading: boolean
  onReview: (id: number, action: 'approve' | 'reject', role?: MemberRole) => Promise<unknown>
}) {
  const { t } = useTranslation('knowledge')
  const review = async (permission: PendingPermissionInfo, approve: boolean) => {
    try {
      await onReview(
        permission.id,
        approve ? 'approve' : 'reject',
        approve ? roles[permission.id] || permission.role || 'Reporter' : undefined
      )
    } catch {
      /* The shared permission hook owns the error state. */
    }
  }
  if (!pending.length)
    return (
      <p
        className="flex items-center gap-2 text-xs text-text-muted"
        data-testid="knowledge-empty-pending"
      >
        <Clock className="h-4 w-4 shrink-0" />
        {t('document.permission.noPendingRequests')}
      </p>
    )
  return (
    <Card padding="default" className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Clock className="w-4 h-4 text-warning" />
        {t('document.permission.pendingRequests')}
        <span className="bg-warning/10 text-warning px-2 py-0.5 rounded-full text-xs">
          {pending.length}
        </span>
      </div>
      <div className="space-y-2">
        {pending.map(permission => (
          <div
            key={permission.id}
            className="flex flex-wrap items-center justify-between gap-3 p-3 bg-muted rounded-lg"
          >
            <div className="min-w-0 flex-1 basis-36">
              <div className="font-medium text-sm break-words">{permission.username}</div>
              <div className="text-xs text-text-muted break-words">
                {permission.email || t('document.permission.noEmail')}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {t('document.permission.requesting')}:{' '}
                {t(`document.permission.role.${permission.role || 'Reporter'}`)}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1 sm:gap-2">
              <Select
                value={roles[permission.id] || permission.role || 'Reporter'}
                onValueChange={value => onRoleChange(permission.id, value as MemberRole)}
              >
                <SelectTrigger
                  className="w-28 h-11 min-w-[44px]"
                  data-testid={`permission-approval-role-${permission.id}`}
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
              <Button
                variant="ghost"
                size="icon"
                className="h-11 min-w-[44px] text-success hover:text-success hover:bg-success/10"
                data-testid={`permission-approve-${permission.id}`}
                aria-label={t('document.permission.approve')}
                disabled={loading}
                onClick={() => void review(permission, true)}
              >
                <Check className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 min-w-[44px] text-error hover:text-error hover:bg-error/10"
                data-testid={`permission-reject-${permission.id}`}
                aria-label={t('document.permission.reject')}
                disabled={loading}
                onClick={() => void review(permission, false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
