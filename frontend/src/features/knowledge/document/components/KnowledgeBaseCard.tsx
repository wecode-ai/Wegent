// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  FileText,
  Pencil,
  Trash2,
  ArrowRight,
  Clock,
  BookOpen,
  FolderOpen,
  Link,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import type { KnowledgeBase } from '@/types/knowledge'

interface KnowledgeBaseCardProps {
  knowledgeBase: KnowledgeBase
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
  canEdit?: boolean
  canDelete?: boolean
}

export function KnowledgeBaseCard({
  knowledgeBase,
  onClick,
  onEdit,
  onDelete,
  canEdit = true,
  canDelete = true,
}: KnowledgeBaseCardProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  // Handle copy link to clipboard
  const handleCopyLink = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const shareUrl = `${window.location.origin}/knowledge/share/${knowledgeBase.id}`

    // Try modern clipboard API first
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl)
        toast({
          description: t('knowledge:share.link_copied'),
        })
        return
      } catch (error) {
        console.error('Clipboard API failed, falling back to execCommand:', error)
      }
    }

    // Fallback to traditional method if clipboard API is not available
    try {
      const textArea = document.createElement('textarea')
      textArea.value = shareUrl
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      toast({
        description: t('knowledge:share.link_copied'),
      })
    } catch (error) {
      console.error('Failed to copy link:', error)
      toast({
        variant: 'destructive',
        description: 'Failed to copy link',
      })
    }
  }

  // Format date for compact display (MM-DD HH:mm)
  const formatDate = (dateString: string) => {
    if (!dateString) return ''
    const date = new Date(dateString)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hours}:${minutes}`
  }

  // Determine knowledge base type (default to 'notebook' for backward compatibility)
  const kbType = knowledgeBase.kb_type || 'notebook'
  const isNotebook = kbType === 'notebook'

  return (
    <Card
      padding="sm"
      className="hover:bg-hover transition-colors cursor-pointer h-[140px] flex flex-col group"
      onClick={onClick}
    >
      {/* Header with type icon and name */}
      <div className="flex items-start pt-1 mb-2 flex-shrink-0 gap-2">
        {/* Type icon */}
        <div
          className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center ${
            isNotebook ? 'bg-primary/10 text-primary' : 'bg-muted text-text-secondary'
          }`}
          title={
            isNotebook
              ? t('knowledge:document.knowledgeBase.typeNotebook')
              : t('knowledge:document.knowledgeBase.typeClassic')
          }
        >
          {isNotebook ? (
            <BookOpen className="w-3.5 h-3.5" />
          ) : (
            <FolderOpen className="w-3.5 h-3.5" />
          )}
        </div>
        <h3 className="font-medium text-sm leading-relaxed line-clamp-2 flex-1">
          <span className="font-semibold">{knowledgeBase.name}</span>
        </h3>
      </div>

      {/* Description or Summary */}
      <div className="text-xs text-text-muted flex-1 min-h-0">
        {knowledgeBase.description ? (
          <p className="line-clamp-2">{knowledgeBase.description}</p>
        ) : knowledgeBase.summary?.short_summary ? (
          <p className="line-clamp-2">{knowledgeBase.summary.short_summary}</p>
        ) : null}
      </div>

      {/* Bottom section - stats on left, actions on right */}
      <div className="flex items-center justify-between mt-auto pt-2 flex-shrink-0">
        {/* Document count and updated time */}
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            <FileText className="w-3 h-3" />
            {knowledgeBase.document_count}
          </span>
          <span
            className="flex items-center gap-1"
            title={
              knowledgeBase.updated_at ? new Date(knowledgeBase.updated_at).toLocaleString() : ''
            }
          >
            <Clock className="w-3 h-3" />
            {formatDate(knowledgeBase.updated_at)}
          </span>
        </div>
        {/* Action icons */}
        <div className="flex items-center gap-1">
          {/* Copy link button */}
          <button
            className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
            onClick={handleCopyLink}
            title={t('knowledge:share.copy_link')}
          >
            <Link className="w-4 h-4" />
          </button>
          {canEdit && onEdit && (
            <button
              className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
              onClick={e => {
                e.stopPropagation()
                onEdit()
              }}
              title={t('common:actions.edit')}
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          {canDelete && onDelete && (
            <button
              className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
              onClick={e => {
                e.stopPropagation()
                onDelete()
              }}
              title={t('common:actions.delete')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
            onClick={e => {
              e.stopPropagation()
              onClick()
            }}
            title={t('common:actions.view')}
          >
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </Card>
  )
}
