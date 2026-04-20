// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Template } from '@/apis/template'

interface TemplateCardProps {
  template: Template
  onImport: (template: Template) => void
  importing: boolean
}

export function TemplateCard({ template, onImport, importing }: TemplateCardProps) {
  const { t } = useTranslation('inbox')

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-base p-4 transition-colors hover:border-primary/30 hover:bg-surface/50"
      data-testid={`template-card-${template.name}`}
    >
      {/* Icon and name */}
      <div className="flex items-start gap-3">
        {template.icon && (
          <span className="text-2xl" data-testid="template-card-icon">
            {template.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-text-primary">
            {template.displayName}
          </h3>
          {template.description && (
            <p className="mt-1 line-clamp-3 text-xs text-text-muted">
              {template.description}
            </p>
          )}
        </div>
      </div>

      {/* Tags */}
      {template.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {template.tags.map(tag => (
            <Badge key={tag} variant="secondary" size="sm">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Import button */}
      <div className="mt-4">
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => onImport(template)}
          disabled={importing}
          data-testid={`template-import-button-${template.name}`}
        >
          {importing ? t('templates.importing') : t('templates.import')}
        </Button>
      </div>
    </div>
  )
}
