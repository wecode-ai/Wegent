// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { listGroups } from '@/apis/groups'
import { teamApis, type TeamResourceMember } from '@/apis/team'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'
import type { Group } from '@/types/group'

interface TeamChildNamespaceAuthorizationDialogProps {
  open: boolean
  team: Team | null
  onOpenChange: (open: boolean) => void
}

export function TeamChildNamespaceAuthorizationDialog({
  open,
  team,
  onOpenChange,
}: TeamChildNamespaceAuthorizationDialogProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<TeamResourceMember[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [updatingGroupIds, setUpdatingGroupIds] = useState<Set<number>>(new Set())

  const childGroups = useMemo(() => {
    if (!team?.namespace || team.namespace === 'default') return []
    const prefix = `${team.namespace}/`
    return groups
      .filter(group => group.name.startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [groups, team?.namespace])

  const authorizationByNamespaceId = useMemo(() => {
    const map = new Map<string, TeamResourceMember>()
    members.forEach(member => {
      if (member.entity_type === 'namespace' && member.entity_id) {
        map.set(member.entity_id, member)
      }
    })
    return map
  }, [members])

  const loadAuthorizations = useCallback(async () => {
    if (!team || !open) return
    setIsLoading(true)
    try {
      const [groupsResponse, membersResponse] = await Promise.all([
        listGroups({ page: 1, limit: 100 }),
        teamApis.listTeamMembers(team.id),
      ])
      setGroups(groupsResponse.items)
      setMembers(membersResponse.members)
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.child_authorization.load_failed'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [open, t, team, toast])

  useEffect(() => {
    void loadAuthorizations()
  }, [loadAuthorizations])

  const updateGroupAuthorization = async (group: Group, checked: boolean) => {
    if (!team) return
    setUpdatingGroupIds(prev => new Set(prev).add(group.id))
    try {
      if (checked) {
        const created = await teamApis.addTeamNamespaceAuthorization(team.id, group.id)
        setMembers(prev => [...prev.filter(member => member.id !== created.id), created])
      } else {
        const member = authorizationByNamespaceId.get(String(group.id))
        if (member) {
          await teamApis.removeTeamMember(team.id, member.id)
          setMembers(prev => prev.filter(item => item.id !== member.id))
        }
      }
      toast({ title: t('teams.child_authorization.save_success') })
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.child_authorization.save_failed'),
      })
    } finally {
      setUpdatingGroupIds(prev => {
        const next = new Set(prev)
        next.delete(group.id)
        return next
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('teams.child_authorization.title')}</DialogTitle>
          <DialogDescription>
            {team
              ? t('teams.child_authorization.description', { name: team.displayName || team.name })
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[360px] overflow-y-auto pr-1" data-testid="team-child-auth-list">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('teams.child_authorization.loading')}
            </div>
          ) : childGroups.length > 0 ? (
            <div className="divide-y divide-border rounded-md border border-border">
              {childGroups.map(group => {
                const checked = authorizationByNamespaceId.has(String(group.id))
                const isUpdating = updatingGroupIds.has(group.id)
                const label = group.display_name || group.name
                return (
                  <label
                    key={group.id}
                    className="flex min-h-[48px] cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={isUpdating}
                      onCheckedChange={value => {
                        void updateGroupAuthorization(group, value === true)
                      }}
                      data-testid={`team-child-auth-checkbox-${group.id}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text-primary">
                        {label}
                      </span>
                      <span className="block truncate text-xs text-text-muted">{group.name}</span>
                    </span>
                    {isUpdating && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                  </label>
                )
              })}
            </div>
          ) : (
            <div
              className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-text-muted"
              data-testid="team-child-auth-empty"
            >
              {t('teams.child_authorization.empty')}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="primary"
            onClick={() => onOpenChange(false)}
            data-testid="team-child-auth-close-button"
          >
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
