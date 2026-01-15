// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { listGroups } from '@/apis/groups'
import { teamApis } from '@/apis/team'
import type { Group, GroupRole } from '@/types/group'
import type { Team } from '@/types/api'
import { useRouter } from 'next/navigation'

interface CopyToGroupDialogProps {
  open: boolean
  onClose: () => void
  team: Team | null
  onSuccess?: (newTeamId: number, groupName: string) => void
}

// Roles that have permission to create resources
const ALLOWED_ROLES: GroupRole[] = ['Owner', 'Maintainer', 'Developer']

export default function CopyToGroupDialog({
  open,
  onClose,
  team,
  onSuccess,
}: CopyToGroupDialogProps) {
  const { t } = useTranslation('common')
  const router = useRouter()
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroup, setSelectedGroup] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch groups when dialog opens
  useEffect(() => {
    if (open) {
      setIsLoading(true)
      setError(null)
      setSelectedGroup('')
      listGroups({ limit: 100 })
        .then(response => {
          setGroups(response.items)
        })
        .catch(() => {
          setError(t('teams.copy_to_group.load_groups_failed'))
        })
        .finally(() => {
          setIsLoading(false)
        })
    }
  }, [open, t])

  // Filter groups where user has Developer+ role
  const availableGroups = useMemo(() => {
    return groups.filter(group => group.my_role && ALLOWED_ROLES.includes(group.my_role))
  }, [groups])

  const handleCopy = async () => {
    if (!team || !selectedGroup) return

    setIsCopying(true)
    setError(null)

    try {
      const result = await teamApis.copyToGroup(team.id, selectedGroup)
      onSuccess?.(result.id, result.namespace)
      onClose()
      // Navigate to the group's team list
      router.push(`/settings?tab=teams&scope=group&group=${selectedGroup}`)
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'detail' in err
            ? String((err as { detail: string }).detail)
            : t('teams.copy_to_group.copy_failed')
      setError(errorMessage)
    } finally {
      setIsCopying(false)
    }
  }

  const handleClose = () => {
    if (!isCopying) {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('teams.copy_to_group.title')}</DialogTitle>
          <DialogDescription>
            {t('teams.copy_to_group.description', { teamName: team?.name || '' })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <svg
                className="animate-spin h-5 w-5 text-primary"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
            </div>
          ) : availableGroups.length === 0 ? (
            <div className="text-center py-4 text-text-muted">
              <p>{t('teams.copy_to_group.no_groups')}</p>
              <p className="text-sm mt-1">{t('teams.copy_to_group.no_groups_hint')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  {t('teams.copy_to_group.select_group')}
                </label>
                <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('teams.copy_to_group.select_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableGroups.map(group => (
                      <SelectItem key={group.name} value={group.name}>
                        <div className="flex items-center gap-2">
                          <span>{group.display_name || group.name}</span>
                          <span className="text-xs text-text-muted">({group.my_role})</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {error && (
                <div className="bg-error/10 text-error text-sm p-3 rounded-md">{error}</div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={handleClose} disabled={isCopying}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCopy}
            disabled={!selectedGroup || isCopying || isLoading || availableGroups.length === 0}
          >
            {isCopying ? (
              <div className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {t('teams.copy_to_group.copying')}
              </div>
            ) : (
              t('teams.copy_to_group.confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
