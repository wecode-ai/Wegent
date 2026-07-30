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
import type { ResourceLibraryListing, ResourceLibraryPublicationUpdateRequest } from '../types'
import { CapabilityScopeSelector, type CapabilityPublishTarget } from './CapabilityScopeSelector'

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

  useEffect(() => {
    if (!open || !listing) return
    const nextGroupNames = listing.target_groups || []
    setGroupNames(nextGroupNames)
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

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={saving || (target === 'team' && groupNames.length === 0)}
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
