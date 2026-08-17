// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import type { UnifiedSkill } from '@/apis/skills'
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
import { CapabilityScopeSelector, type CapabilityPublishTarget } from './CapabilityScopeSelector'
import { MarketplaceTagSelector } from './MarketplaceTagSelector'

interface SkillShareScopeDialogProps {
  skill: UnifiedSkill | null
  groups: Group[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}

export function SkillShareScopeDialog({
  skill,
  groups,
  open,
  onOpenChange,
  onSaved,
}: SkillShareScopeDialogProps) {
  const { t } = useTranslation('resource-library')
  const [target, setTarget] = useState<CapabilityPublishTarget>('personal')
  const [groupNames, setGroupNames] = useState<string[]>([])
  const [marketplaceTags, setMarketplaceTags] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const onOpenChangeRef = useRef(onOpenChange)
  const translateRef = useRef(t)
  onOpenChangeRef.current = onOpenChange
  translateRef.current = t
  const skillId = skill?.id

  const writableGroups = useMemo(
    () =>
      groups.filter(
        group =>
          group.my_role === 'Owner' ||
          group.my_role === 'Maintainer' ||
          group.my_role === 'Developer'
      ),
    [groups]
  )

  useEffect(() => {
    if (!open || !skillId) return

    let cancelled = false
    setLoading(true)
    resourceLibraryApi
      .getPublication(skillId)
      .then(listing => {
        if (cancelled) return
        const nextGroupNames = listing.target_groups || []
        setGroupNames(nextGroupNames)
        setMarketplaceTags(listing.tags || [])
        setTarget(
          listing.status === 'published'
            ? 'marketplace'
            : nextGroupNames.length > 0
              ? 'team'
              : 'personal'
        )
      })
      .catch(error => {
        if (cancelled) return
        toast.error(
          error instanceof Error
            ? error.message
            : translateRef.current('messages.publication_load_failed')
        )
        onOpenChangeRef.current(false)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, skillId])

  const handleSave = async () => {
    if (!skill) return
    if (target === 'team' && groupNames.length === 0) {
      toast.error(t('new_capability.select_groups'))
      return
    }
    if (target === 'marketplace' && marketplaceTags.length === 0) {
      toast.error(t('marketplace_tags.required'))
      return
    }

    setSaving(true)
    try {
      await resourceLibraryApi.updatePublication(skill.id, {
        status: target === 'marketplace' ? 'published' : 'archived',
        target_groups: target === 'team' ? groupNames : [],
        allow_personal_install: target === 'marketplace',
        allow_group_install: target !== 'personal',
        ...(target === 'marketplace' ? { tags: marketplaceTags } : {}),
      })
      toast.success(t('messages.update_success'))
      onOpenChange(false)
      onSaved?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('messages.update_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-[680px]"
        data-testid="skill-share-scope-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('publication.edit_share_scope')}</DialogTitle>
          <DialogDescription>{t('publication.edit_share_scope_description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center text-sm text-text-muted">
            {t('messages.publication_loading')}
          </div>
        ) : (
          <>
            <CapabilityScopeSelector
              value={target}
              groups={writableGroups}
              groupName={groupNames[0]}
              groupNames={groupNames}
              onChange={(nextTarget, nextGroupName, nextGroupNames) => {
                setTarget(nextTarget)
                setGroupNames(
                  nextTarget === 'team'
                    ? nextGroupNames || (nextGroupName ? [nextGroupName] : [])
                    : []
                )
              }}
              existingResource
              multipleGroups
            />

            {target === 'marketplace' && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-text-primary">
                  {t('marketplace_tags.field_label')}
                </h3>
                <MarketplaceTagSelector value={marketplaceTags} onChange={setMarketplaceTags} />
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={
              loading || saving || (target === 'marketplace' && marketplaceTags.length === 0)
            }
            onClick={handleSave}
            data-testid="skill-share-scope-save"
          >
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
