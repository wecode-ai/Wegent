// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Code2, MoreHorizontal, Unlink } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { removeSkillFromGroup } from '@/apis/skills'
import { ResourceCardFooter } from '@/components/common/ResourceCardFooter'
import { getResourceGridClassName } from '@/components/common/resourceCardLayout'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { isEditor } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ResourceLibraryInstall } from '../types'

interface GroupInstallItem {
  groupNamespace: string
  install: ResourceLibraryInstall
}

export function GroupInstalledSkills({
  groupNamespaces,
  groups,
}: {
  groupNamespaces: string[]
  groups: Group[]
}) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [installs, setInstalls] = useState<GroupInstallItem[]>([])
  const [pendingRemoval, setPendingRemoval] = useState<GroupInstallItem | null>(null)
  const [removingKey, setRemovingKey] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    Promise.all(
      groupNamespaces.map(async groupNamespace => {
        try {
          const response = await resourceLibraryApi.listGroupInstalls(groupNamespace, {
            resourceType: 'skill',
            page: 1,
            limit: 100,
          })
          return response.items.map(install => ({ groupNamespace, install }))
        } catch {
          return []
        }
      })
    ).then(results => {
      if (isMounted) setInstalls(results.flat())
    })

    return () => {
      isMounted = false
    }
  }, [groupNamespaces])

  if (installs.length === 0) {
    return null
  }

  const removePendingSkill = async () => {
    const listing = pendingRemoval?.install.listing
    if (!pendingRemoval || !listing) return

    const key = `${pendingRemoval.groupNamespace}:${pendingRemoval.install.id}`
    setRemovingKey(key)
    try {
      await removeSkillFromGroup(listing.id, pendingRemoval.groupNamespace)
      setInstalls(current =>
        current.filter(
          item =>
            !(
              item.groupNamespace === pendingRemoval.groupNamespace &&
              item.install.id === pendingRemoval.install.id
            )
        )
      )
      setPendingRemoval(null)
      toast({ title: t('messages.remove_from_team_success') })
    } catch (error) {
      toast({
        title: t('messages.remove_from_team_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setRemovingKey(null)
    }
  }

  const pendingListing = pendingRemoval?.install.listing
  const pendingGroup = groups.find(item => item.name === pendingRemoval?.groupNamespace)

  return (
    <>
      <section className="space-y-3" data-testid="group-installed-skills">
        <h2 className="text-sm font-semibold text-text-secondary">
          {t('fields.group_added_skills')}
        </h2>
        <div className={getResourceGridClassName(true)}>
          {installs.map(({ groupNamespace, install }) => {
            const listing = install.listing
            if (!listing) return null
            const group = groups.find(item => item.name === groupNamespace)
            const key = `${groupNamespace}:${install.id}`
            const canRemove = isEditor(group?.my_role)
            return (
              <Card key={key} className="flex min-h-32 flex-col gap-3 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border">
                    <Code2 className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold text-text-primary">
                      {listing.display_name || listing.name}
                    </h3>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="info">{t('filters.skill')}</Badge>
                      <Badge variant="secondary">
                        {group?.display_name || group?.name || groupNamespace}
                      </Badge>
                    </div>
                  </div>
                  {canRemove && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          disabled={removingKey === key}
                          aria-label={t('actions.more')}
                          data-testid={`group-skill-actions-${install.id}`}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          danger
                          onSelect={() => setPendingRemoval({ groupNamespace, install })}
                          data-testid={`group-skill-remove-${install.id}`}
                        >
                          <Unlink className="mr-2 h-4 w-4" aria-hidden />
                          {t('actions.remove_from_team')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <p className="line-clamp-2 text-sm text-text-secondary">
                  {listing.description || listing.name}
                </p>
                <ResourceCardFooter
                  owner={
                    listing.publisher_user_id === 0
                      ? t('fields.official_publisher')
                      : listing.publisher_user_name || listing.publisher_namespace
                  }
                  updatedAt={listing.updated_at}
                  testId={`group-installed-skill-footer-${install.id}`}
                />
              </Card>
            )
          })}
        </div>
      </section>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={open => {
          if (!open && !removingKey) setPendingRemoval(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('actions.remove_from_team')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('messages.remove_from_team_confirm', {
                skill: pendingListing?.display_name || pendingListing?.name || '',
                group:
                  pendingGroup?.display_name ||
                  pendingGroup?.name ||
                  pendingRemoval?.groupNamespace ||
                  '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingKey !== null}>
              {t('actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-error text-white hover:bg-error/90"
              disabled={removingKey !== null}
              onClick={event => {
                event.preventDefault()
                void removePendingSkill()
              }}
              data-testid="confirm-remove-group-skill"
            >
              {t('actions.remove_from_team')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
