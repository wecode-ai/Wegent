// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Dialog component for editing device alias (display name).
 */

'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DeviceInfo } from '@/apis/devices'
import { useTranslation } from '@/hooks/useTranslation'

export interface EditDeviceAliasDialogProps {
  device: DeviceInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (device: DeviceInfo, newAlias: string) => Promise<void>
}

/**
 * Dialog for editing a device's alias (display name).
 *
 * Features:
 * - Pre-fills with current device name
 * - Validates non-empty input
 * - Shows loading state during save
 */
export function EditDeviceAliasDialog({
  device,
  open,
  onOpenChange,
  onSave,
}: EditDeviceAliasDialogProps) {
  const { t } = useTranslation('devices')
  const [alias, setAlias] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Reset alias when device changes or dialog opens
  useEffect(() => {
    if (device && open) {
      setAlias(device.name)
    }
  }, [device, open])

  const handleSave = async () => {
    if (!device || !alias.trim()) return

    setIsSaving(true)
    try {
      await onSave(device, alias.trim())
      onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && alias.trim()) {
      handleSave()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('edit_alias_title')}</DialogTitle>
          <DialogDescription>{t('edit_alias_description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="alias">{t('alias_label')}</Label>
            <Input
              id="alias"
              data-testid="device-alias-input"
              value={alias}
              onChange={e => setAlias(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('alias_placeholder')}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="save-alias-button"
            onClick={handleSave}
            disabled={!alias.trim() || isSaving}
          >
            {isSaving ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
