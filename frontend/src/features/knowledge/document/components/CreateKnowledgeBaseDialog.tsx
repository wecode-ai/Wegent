// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'

interface CreateKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { name: string; description?: string }) => Promise<void>
  loading?: boolean
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: CreateKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!name.trim()) {
      setError(t('knowledge.document.knowledgeBase.nameRequired'))
      return
    }

    if (name.length > 100) {
      setError(t('knowledge.document.knowledgeBase.nameTooLong'))
      return
    }

    try {
      await onSubmit({ name: name.trim(), description: description.trim() || undefined })
      setName('')
      setDescription('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setName('')
      setDescription('')
      setError('')
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge.document.knowledgeBase.create')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('knowledge.document.knowledgeBase.name')}</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('knowledge.document.knowledgeBase.namePlaceholder')}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('knowledge.document.knowledgeBase.description')}</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('knowledge.document.knowledgeBase.descriptionPlaceholder')}
                maxLength={500}
                rows={3}
              />
            </div>
            {error && <p className="text-sm text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? t('actions.creating') : t('actions.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
