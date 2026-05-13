// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'

interface CreateFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
  /** Pre-populate with this value (for rename mode) */
  initialName?: string
  isSubmitting?: boolean
}

export function CreateFolderDialog({
  open,
  onOpenChange,
  onSubmit,
  initialName,
  isSubmitting = false,
}: CreateFolderDialogProps) {
  const { t } = useTranslation('knowledge')
  const [name, setName] = useState('')

  const isRename = !!initialName

  useEffect(() => {
    if (open && initialName) {
      setName(initialName)
    } else if (!open) {
      setName('')
    }
  }, [open, initialName])

  const handleSubmit = () => {
    if (isSubmitting) return
    const trimmed = name.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  const handleClose = () => {
    setName('')
    onOpenChange(false)
  }

  const title = isRename ? t('document.folder.renameTitle') : t('document.folder.createTitle')
  const placeholder = isRename
    ? t('document.folder.renamePlaceholder')
    : t('document.folder.createPlaceholder')
  const actionLabel = isRename ? t('common:actions.save') : t('common:actions.create')

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Input
            placeholder={placeholder}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSubmit()
            }}
            autoFocus
            maxLength={255}
            data-testid="folder-name-input"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
            data-testid="folder-dialog-cancel"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!name.trim() || isSubmitting}
            data-testid="folder-dialog-submit"
          >
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
