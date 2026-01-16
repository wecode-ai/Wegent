// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
import type { KnowledgeDocument, SplitterConfig } from '@/types/knowledge'
import { SplitterSettingsSection } from './SplitterSettingsSection'

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
  const [splitterConfig, setSplitterConfig] = useState<Partial<SplitterConfig>>({
    type: 'sentence',
    separator: '\n\n',
    chunk_size: 1024,
    chunk_overlap: 50,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Check if this is a table document
  const isTableDocument = document?.source_type === 'table'
  const tableUrl = isTableDocument ? (document.source_config?.url as string) : ''

  // Reset form when document changes
  useEffect(() => {
    if (document) {
      setName(document.name)
      // Load existing splitter_config or use defaults
      if (document.splitter_config) {
        const config = document.splitter_config
        if (config.type === 'semantic') {
          setSplitterConfig({
            type: 'semantic',
            buffer_size: config.buffer_size ?? 1,
            breakpoint_percentile_threshold: config.breakpoint_percentile_threshold ?? 95,
          })
        } else {
          // Default to sentence splitter
          setSplitterConfig({
            type: 'sentence',
            separator: config.type === 'sentence' ? (config.separator ?? '\n\n') : '\n\n',
            chunk_size: config.type === 'sentence' ? (config.chunk_size ?? 1024) : 1024,
            chunk_overlap: config.type === 'sentence' ? (config.chunk_overlap ?? 50) : 50,
          })
        }
      } else {
        setSplitterConfig({
          type: 'sentence',
          separator: '\n\n',
          chunk_size: 1024,
          chunk_overlap: 50,
        })
      }
      setError('')
      setShowAdvanced(false) // Reset to collapsed state
    }
  }, [document])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!document) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('knowledge:document.document.nameRequired'))
      return
    }

    setLoading(true)
    setError('')

    try {
      // Only update name, splitter_config is read-only
      await updateDocument(document.id, {
        name: trimmedName,
      })
      onSuccess()
    } catch (err) {
      setError(t('knowledge:document.document.updateFailed'))
      console.error('Failed to update document:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.document.edit')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4 space-y-6">
            {/* Document Name */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {t('knowledge:document.document.columns.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('knowledge:document.document.namePlaceholder')}
                autoFocus
              />
            </div>

            {/* Table URL Display (Read-only for table documents) */}
            {isTableDocument && tableUrl && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  {t('knowledge:document.upload.tableUrl')}
                </label>
                <div className="w-full px-3 py-2 text-sm bg-surface-secondary border border-border rounded-md text-text-muted break-all">
                  {tableUrl}
                </div>
                <p className="text-xs text-text-muted mt-1">
                  {t('knowledge:document.advancedSettings.readOnly')}
                </p>
              </div>
            )}

            {/* Advanced Settings - Splitter Configuration (Collapsible, Read-only) */}
            {!isTableDocument && (
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors w-full"
                >
                  {showAdvanced ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  {t('knowledge:document.splitter.title')}
                  <span className="text-xs text-text-muted font-normal ml-auto">
                    {t('knowledge:document.advancedSettings.readOnly')}
                  </span>
                </button>

                {showAdvanced && (
                  <div className="mt-4">
                    <SplitterSettingsSection
                      config={splitterConfig}
                      onChange={() => {}} // No-op since it's read-only
                      readOnly={true}
                    />
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-xs text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !name.trim()}>
              {loading ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
