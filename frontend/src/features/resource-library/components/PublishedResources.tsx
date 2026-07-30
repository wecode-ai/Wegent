// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Archive,
  Bot,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'

import { listGroups } from '@/apis/groups'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { getSkill } from '@/apis/skills'
import {
  getResourceCardClassName,
  getResourceGridClassName,
  ResourceCardIcon,
} from '@/components/common/resourceCardLayout'
import { ResourceCardFooter } from '@/components/common/ResourceCardFooter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Skeleton } from '@/components/ui/skeleton'
import SkillUploadModal from '@/features/settings/components/skills/SkillUploadModal'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { Skill } from '@/types/api'
import type { Group } from '@/types/group'
import type { ResourceLibraryListing, ResourceLibraryTypeFilter } from '../types'
import { PublicationSettingsDialog } from './PublicationSettingsDialog'

interface PublishedResourcesProps {
  resourceType: ResourceLibraryTypeFilter
}

function getPublicationTarget(
  listing: ResourceLibraryListing
): 'personal' | 'team' | 'marketplace' {
  if (listing.status === 'published') return 'marketplace'
  if (listing.target_groups?.length) return 'team'
  return 'personal'
}

export function PublishedResources({ resourceType }: PublishedResourcesProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [items, setItems] = useState<ResourceLibraryListing[]>([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [openingEditorId, setOpeningEditorId] = useState<number | null>(null)
  const [skillVersionUpdate, setSkillVersionUpdate] = useState<{
    listing: ResourceLibraryListing
    skill: Skill
  } | null>(null)
  const [publicationSettings, setPublicationSettings] = useState<ResourceLibraryListing | null>(
    null
  )
  const [writableGroups, setWritableGroups] = useState<Group[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    if (resourceType !== 'all' && resourceType !== 'agent' && resourceType !== 'skill') {
      setItems([])
      setLoading(false)
      return
    }
    try {
      const response = await resourceLibraryApi.listMyPublished({
        resourceType,
        page: 1,
        limit: 100,
      })
      setItems(response.items)
    } finally {
      setLoading(false)
    }
  }, [resourceType])

  useEffect(() => {
    void load()
  }, [load])

  const update = async (
    listing: ResourceLibraryListing,
    request: Parameters<typeof resourceLibraryApi.updatePublication>[1]
  ): Promise<boolean> => {
    setUpdatingId(listing.id)
    try {
      await resourceLibraryApi.updatePublication(listing.id, request)
      toast({ title: t('messages.update_success') })
      await load()
      return true
    } catch (error) {
      toast({
        title: t('messages.update_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      return false
    } finally {
      setUpdatingId(null)
    }
  }

  const openPublicationSettings = async (listing: ResourceLibraryListing) => {
    setOpeningEditorId(listing.id)
    try {
      const response = await listGroups({ page: 1, limit: 100 })
      setWritableGroups(
        response.items.filter(
          group =>
            group.my_role === 'Owner' ||
            group.my_role === 'Maintainer' ||
            group.my_role === 'Developer'
        )
      )
      setPublicationSettings(listing)
    } catch (error) {
      toast({
        title: t('messages.groups_load_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setOpeningEditorId(null)
    }
  }

  const savePublicationSettings = async (
    request: Parameters<typeof resourceLibraryApi.updatePublication>[1]
  ) => {
    if (!publicationSettings) return
    if (await update(publicationSettings, request)) {
      setPublicationSettings(null)
    }
  }

  const openSkillVersionUpdate = async (listing: ResourceLibraryListing) => {
    setOpeningEditorId(listing.id)
    try {
      const skill = await getSkill(listing.id)
      setSkillVersionUpdate({ listing, skill })
    } catch (error) {
      toast({
        title: t('messages.update_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setOpeningEditorId(null)
    }
  }

  const handleSkillVersionUpdateClose = async (saved: boolean, skillId?: number) => {
    const pendingUpdate = skillVersionUpdate
    setSkillVersionUpdate(null)
    if (!saved || !pendingUpdate) return

    try {
      const skill = await getSkill(skillId || pendingUpdate.listing.id)
      await update(pendingUpdate.listing, {
        display_name: skill.spec.displayName || skill.metadata.name,
        description: skill.spec.description || null,
        tags: skill.spec.tags || [],
        version: skill.spec.version || pendingUpdate.listing.current_version?.version || '1.0.0',
        status: 'published',
      })
    } catch (error) {
      toast({
        title: t('messages.update_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }

  if (loading) {
    return (
      <div className={getResourceGridClassName(true)}>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-56 rounded-xl" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div
        className="flex min-h-48 items-center justify-center text-sm text-text-muted"
        data-testid="published-resources-empty"
      >
        {t('empty.published')}
      </div>
    )
  }

  return (
    <>
      <div className={getResourceGridClassName(true)} data-testid="published-resources">
        {items.map(listing => {
          const disabled = updatingId === listing.id || openingEditorId === listing.id
          return (
            <Card
              key={listing.id}
              className={getResourceCardClassName(true)}
              data-testid={`published-resource-card-${listing.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-3">
                  <ResourceCardIcon compact>
                    {listing.resource_type === 'agent' ? (
                      <Bot className="h-5 w-5" aria-hidden />
                    ) : (
                      <Sparkles className="h-5 w-5" aria-hidden />
                    )}
                  </ResourceCardIcon>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-text-primary">
                      {listing.display_name || listing.name}
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge
                        variant={listing.status === 'published' ? 'info' : 'secondary'}
                        className="shrink-0 whitespace-nowrap"
                      >
                        {t(`status.${listing.status}`)}
                      </Badge>
                      {listing.current_version?.version && (
                        <span className="text-xs text-text-muted">
                          v{listing.current_version.version}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-text-secondary"
                      disabled={disabled}
                      aria-label={t('publication.settings')}
                      data-testid={`publication-more-actions-${listing.id}`}
                    >
                      <MoreHorizontal className="h-5 w-5" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-52"
                    data-testid={`publication-actions-menu-${listing.id}`}
                  >
                    {listing.resource_type === 'skill' && (
                      <>
                        <DropdownMenuItem
                          disabled={disabled}
                          onSelect={() => void openSkillVersionUpdate(listing)}
                          data-testid={`publication-publish-version-${listing.id}`}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                          {t('actions.edit_and_publish')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      disabled={disabled}
                      onSelect={() => void openPublicationSettings(listing)}
                      data-testid={`publication-edit-scope-${listing.id}`}
                    >
                      <SlidersHorizontal className="h-4 w-4" aria-hidden />
                      {t('publication.edit_scope')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={disabled}
                      danger={listing.status === 'published'}
                      onSelect={() =>
                        void update(listing, {
                          status: listing.status === 'published' ? 'archived' : 'published',
                        })
                      }
                      data-testid={`publication-status-${listing.id}`}
                    >
                      {listing.status === 'published' ? (
                        <Archive className="h-4 w-4" aria-hidden />
                      ) : (
                        <RefreshCw className="h-4 w-4" aria-hidden />
                      )}
                      {listing.status === 'published' ? t('actions.archive') : t('actions.restore')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
                {listing.description || listing.name}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {t(`new_capability.scopes.${getPublicationTarget(listing)}`)}
                </Badge>
                {getPublicationTarget(listing) === 'team' &&
                  Boolean(listing.target_groups?.length) && (
                    <Badge variant="secondary">
                      {t('publication.target_groups_count', {
                        count: listing.target_groups?.length || 0,
                      })}
                    </Badge>
                  )}
              </div>
              <ResourceCardFooter
                owner={
                  listing.publisher_user_id === 0
                    ? t('fields.official_publisher')
                    : listing.publisher_user_name || listing.publisher_namespace
                }
                updatedAt={listing.updated_at}
                className="pt-4"
                testId={`published-resource-footer-${listing.id}`}
              />
            </Card>
          )
        })}
      </div>
      {skillVersionUpdate && (
        <SkillUploadModal
          open
          skill={skillVersionUpdate.skill}
          namespace={skillVersionUpdate.skill.metadata.namespace}
          onClose={handleSkillVersionUpdateClose}
        />
      )}
      <PublicationSettingsDialog
        listing={publicationSettings}
        groups={writableGroups}
        open={Boolean(publicationSettings)}
        saving={Boolean(publicationSettings && updatingId === publicationSettings.id)}
        onOpenChange={open => {
          if (!open) setPublicationSettings(null)
        }}
        onSave={request => void savePublicationSettings(request)}
      />
    </>
  )
}
