// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { Group } from '@/types/group'
import type {
  MarketplaceExampleConversation,
  ResourceLibraryListing,
  ResourceLibraryPublicationUpdateRequest,
} from '../types'
import { CapabilityScopeSelector, type CapabilityPublishTarget } from './CapabilityScopeSelector'
import { ExampleConversationsEditor } from './ExampleConversationsEditor'
import { MarketplaceTagSelector } from './MarketplaceTagSelector'

interface PublicationSettingsDialogProps {
  listing: ResourceLibraryListing | null
  groups: Group[]
  open: boolean
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (request: ResourceLibraryPublicationUpdateRequest) => void
}

export function PublicationSettingsDialog({
  listing,
  groups,
  open,
  saving,
  onOpenChange,
  onSave,
}: PublicationSettingsDialogProps) {
  const { t } = useTranslation('resource-library')
  const [target, setTarget] = useState<CapabilityPublishTarget>('personal')
  const [groupNames, setGroupNames] = useState<string[]>([])
  const [marketplaceTags, setMarketplaceTags] = useState<string[]>([])
  const [exampleConversations, setExampleConversations] = useState<
    MarketplaceExampleConversation[]
  >([])
  const supportsMarketplaceTags =
    listing?.resource_type === 'agent' || listing?.resource_type === 'skill'

  useEffect(() => {
    if (!open || !listing) return
    const nextGroupNames = listing.target_groups || []
    setGroupNames(nextGroupNames)
    setMarketplaceTags(listing.tags)
    setExampleConversations(listing.example_conversations || [])
    setTarget(
      listing.status === 'published'
        ? 'marketplace'
        : nextGroupNames.length > 0
          ? 'team'
          : 'personal'
    )
  }, [listing, open])

  const handleSave = () => {
    onSave({
      status: target === 'marketplace' ? 'published' : 'archived',
      target_groups: target === 'team' ? groupNames : [],
      allow_personal_install: target === 'marketplace',
      allow_group_install: target !== 'personal',
      ...(target === 'marketplace' && supportsMarketplaceTags ? { tags: marketplaceTags } : {}),
      ...(target === 'marketplace' && listing?.resource_type === 'agent'
        ? {
            example_conversations: exampleConversations.map(item => ({
              title: item.title.trim(),
              url: item.url.trim(),
            })),
          }
        : {}),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-[560px]"
        data-testid="publication-settings-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('publication.edit_scope')}</DialogTitle>
          <DialogDescription>{t('publication.edit_scope_description')}</DialogDescription>
        </DialogHeader>

        <CapabilityScopeSelector
          value={target}
          groups={groups}
          groupName={groupNames[0]}
          groupNames={groupNames}
          onChange={(nextTarget, nextGroupName, nextGroupNames) => {
            setTarget(nextTarget)
            if (nextTarget === 'team') {
              setGroupNames(nextGroupNames || (nextGroupName ? [nextGroupName] : []))
            }
          }}
          existingResource
          multipleGroups
        />

        {target === 'marketplace' && supportsMarketplaceTags && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-text-primary">
              {t('marketplace_tags.field_label')}
            </h3>
            <MarketplaceTagSelector value={marketplaceTags} onChange={setMarketplaceTags} />
          </div>
        )}

        {target === 'marketplace' && listing?.resource_type === 'agent' && (
          <ExampleConversationsEditor
            value={exampleConversations}
            onChange={setExampleConversations}
            testIdPrefix="publication-example-conversations"
          />
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={
              saving ||
              (target === 'team' && groupNames.length === 0) ||
              (target === 'marketplace' &&
                supportsMarketplaceTags &&
                marketplaceTags.length === 0) ||
              (target === 'marketplace' &&
                listing?.resource_type === 'agent' &&
                exampleConversations.some(item => !item.title.trim() || !item.url.trim()))
            }
            onClick={handleSave}
            data-testid="publication-settings-save"
          >
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
