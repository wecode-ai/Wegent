// SPDX-FileCopyrightText: 2025 WeCode, Inc.
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
import { useTranslation } from '@/hooks/useTranslation'
import { updateDocument } from '@/apis/knowledge'
import type { KnowledgeDocument } from '@/types/knowledge'

interface EditDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  onSuccess: () => void
}

export function EditDocumentDialog({
  open,
  onOpenChange,
  document,
  onSuccess,
}: EditDocumentDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Reset form when document changes
  useEffect(() => {
    if (document) {
      setName(document.name)
      setError('')
    }
  }, [document])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!document) return
    
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('knowledge.document.document.nameRequired'))
      return
    }

    setLoading(true)
    setError('')

    try {
      await updateDocument(document.id, { name: trimmedName })
      onSuccess()
    } catch (err) {
      setError(t('knowledge.document.document.updateFailed'))
      console.error('Failed to update document:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge.document.document.edit')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {t('knowledge.document.document.columns.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('knowledge.document.document.namePlaceholder')}
                autoFocus
              />
              {error && (
                <p className="mt-1.5 text-xs text-error">{error}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !name.trim()}
            >
              {loading ? t('actions.saving') : t('actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
