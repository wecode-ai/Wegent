// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { Button } from '@/components/ui/button'
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
import { MarketplaceTagSelector } from './MarketplaceTagSelector'

interface MarketplaceTagsDialogProps {
  resourceId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}

export function MarketplaceTagsDialog({
  resourceId,
  open,
  onOpenChange,
  onSaved,
}: MarketplaceTagsDialogProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const tRef = useRef(t)
  const toastRef = useRef(toast)
  const onOpenChangeRef = useRef(onOpenChange)
  tRef.current = t
  toastRef.current = toast
  onOpenChangeRef.current = onOpenChange
  const [tags, setTags] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || resourceId === null) return

    let cancelled = false
    setLoading(true)
    resourceLibraryApi
      .getPublication(resourceId)
      .then(listing => {
        if (!cancelled) setTags(listing.tags)
      })
      .catch(error => {
        if (!cancelled) {
          toastRef.current({
            title: tRef.current('marketplace_tags.load_failed'),
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          })
          onOpenChangeRef.current(false)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, resourceId])

  const handleSave = async () => {
    if (resourceId === null || tags.length === 0) return
    setSaving(true)
    try {
      await resourceLibraryApi.updatePublication(resourceId, { tags })
      toast({ title: t('marketplace_tags.saved') })
      onSaved?.()
      onOpenChange(false)
    } catch (error) {
      toast({
        title: t('marketplace_tags.save_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="marketplace-tags-dialog">
        <DialogHeader>
          <DialogTitle>{t('marketplace_tags.edit_title')}</DialogTitle>
          <DialogDescription>{t('marketplace_tags.edit_description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-text-muted">{t('marketplace_tags.loading')}</p>
        ) : (
          <MarketplaceTagSelector value={tags} onChange={setTags} disabled={saving} />
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="marketplace-tags-dialog-cancel"
          >
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={loading || saving || tags.length === 0}
            onClick={handleSave}
            data-testid="marketplace-tags-dialog-save"
          >
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
