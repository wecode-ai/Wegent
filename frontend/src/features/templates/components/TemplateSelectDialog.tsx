// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTemplates } from '../hooks/useTemplates'
import { TemplateCard } from './TemplateCard'
import {
  instantiateTemplate,
  type Template,
  type TemplateInstantiateResponse,
} from '@/apis/template'
import { toast } from 'sonner'

interface TemplateSelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  category?: string
  onImported?: (result: TemplateInstantiateResponse) => void
}

export function TemplateSelectDialog({
  open,
  onOpenChange,
  category = 'inbox',
  onImported,
}: TemplateSelectDialogProps) {
  const { t } = useTranslation('inbox')
  const { templates, loading, error } = useTemplates({ category, autoLoad: open })
  const [importingId, setImportingId] = useState<number | null>(null)

  const handleImport = async (template: Template) => {
    if (importingId !== null) return
    setImportingId(template.id)
    try {
      const result = await instantiateTemplate(template.id)
      toast.success(t('templates.import_success', { queueName: result.queueName }))
      onOpenChange(false)
      onImported?.(result)
    } catch {
      toast.error(t('templates.import_failed'))
    } finally {
      setImportingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="template-select-dialog">
        <DialogHeader>
          <DialogTitle>{t('templates.title')}</DialogTitle>
          <p className="text-sm text-text-muted">{t('templates.description')}</p>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-text-muted">
              {t('common:actions.loading')}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-12 text-sm text-destructive">
              {error}
            </div>
          ) : templates.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-text-muted">
              {t('templates.empty')}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {templates.map(template => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onImport={handleImport}
                  importing={importingId !== null}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
