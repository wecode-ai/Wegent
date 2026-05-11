// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, FormEvent } from 'react'
import { Users, XCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { listGroups } from '@/apis/groups'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole } from '@/types/knowledge'
import type { Group } from '@/types/group'

interface AddNamespaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
}

export function AddNamespaceDialog({
  open,
  onOpenChange,
  kbId,
  onSuccess,
}: AddNamespaceDialogProps) {
  const { t } = useTranslation('knowledge')
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [loading, setLoading] = useState(false)
  const [fetchingGroups, setFetchingGroups] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch groups when dialog opens
  useEffect(() => {
    if (open) {
      fetchGroups()
    }
  }, [open])

  const fetchGroups = async () => {
    setFetchingGroups(true)
    try {
      const result = await listGroups({ limit: 100 })
      setGroups(result.items || [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch groups'
      setError(message)
    } finally {
      setFetchingGroups(false)
    }
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)

    if (!selectedGroupId) {
      setError(t('common:required') || '请选择群组')
      return
    }

    setLoading(true)
    try {
      await knowledgePermissionApi.addNamespacePermission(kbId, selectedGroupId, role)
      resetForm()
      onSuccess?.()
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add namespace permission'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setSelectedGroupId(null)
    setRole('Reporter')
    setError(null)
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  const selectedGroup = groups.find(g => g.id === selectedGroupId)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            {t('document.permission.addNamespace') || '添加群组权限'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Group selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('document.permission.selectGroup') || '选择群组'}
            </label>
            {fetchingGroups ? (
              <div className="flex items-center justify-center py-4">
                <Spinner />
              </div>
            ) : (
              <Select
                value={selectedGroupId ? String(selectedGroupId) : ''}
                onValueChange={value => setSelectedGroupId(Number(value))}
              >
                <SelectTrigger className="w-full h-11 min-w-[44px]">
                  <SelectValue
                    placeholder={t('document.permission.selectGroupPlaceholder') || '请选择群组'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {groups.map(group => (
                    <SelectItem key={group.id} value={String(group.id)}>
                      {group.display_name || group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedGroup && (
              <p className="text-xs text-text-muted">
                {t('document.permission.groupMembers') || '群组成员'}:
                {' '}{selectedGroup.member_count || '?'}
              </p>
            )}
          </div>

          {/* Role selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('document.permission.role') || '角色'}
            </label>
            <Select value={role} onValueChange={v => setRole(v as MemberRole)}>
              <SelectTrigger className="w-full h-11 min-w-[44px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map(r => (
                  <SelectItem key={r} value={r}>
                    {t(`document.permission.role.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Error message */}
          {error && (
            <div className="flex items-center gap-1.5 text-sm text-error bg-error/10 px-3 py-2 rounded-lg">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !selectedGroupId}
            >
              {loading ? <Spinner className="w-4 h-4" /> : (t('document.permission.add') || '添加')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
