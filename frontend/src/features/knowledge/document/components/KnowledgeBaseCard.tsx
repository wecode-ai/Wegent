// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FolderOpen, Pencil, Trash2, FileText, ArrowRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface KnowledgeBaseCardProps {
  knowledgeBase: KnowledgeBase
  onEdit?: (kb: KnowledgeBase) => void
  onDelete?: (kb: KnowledgeBase) => void
  onClick?: (kb: KnowledgeBase) => void
  canManage?: boolean
}

export function KnowledgeBaseCard({
  knowledgeBase,
  onEdit,
  onDelete,
  onClick,
  canManage = true,
}: KnowledgeBaseCardProps) {
  const { t } = useTranslation()

  const handleCardClick = () => {
    onClick?.(knowledgeBase)
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdit?.(knowledgeBase)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete?.(knowledgeBase)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString()
  }

  return (
    <Card
      padding="sm"
      className="hover:bg-hover transition-colors cursor-pointer h-[120px] flex flex-col group"
      onClick={handleCardClick}
    >
      {/* Header with icon and title */}
      <div className="flex items-start gap-2 mb-2">
        <div className="p-1.5 bg-primary/10 rounded-lg flex-shrink-0">
          <FolderOpen className="w-4 h-4 text-primary" />
        </div>
        <h3 className="font-medium text-sm text-text-primary line-clamp-2 flex-1">
          {knowledgeBase.name}
        </h3>
      </div>

      {/* Description */}
      <div className="text-xs text-text-muted flex-1 min-h-0">
        {knowledgeBase.description && (
          <p className="line-clamp-2">{knowledgeBase.description}</p>
        )}
      </div>

      {/* Footer with stats and actions */}
      <div className="flex items-center justify-between mt-auto pt-2">
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            <FileText className="w-3 h-3" />
            {knowledgeBase.document_count}
          </span>
          <span>{formatDate(knowledgeBase.updated_at)}</span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {canManage && (
            <>
              <button
                className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                onClick={handleEdit}
                title={t('actions.edit')}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
                onClick={handleDelete}
                title={t('actions.delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onClick?.(knowledgeBase)
            }}
            title={t('actions.view')}
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </Card>
  )
}
