// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  FileText,
  Link,
  Paperclip,
  Layers,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Question, QuestionStatus, ContentType } from '@wecode/types/evaluation'

/**
 * Props for the QuestionCard component
 */
interface QuestionCardProps {
  /** The question data to display */
  question: Question
  /** Display index (1-based) for the question number */
  displayIndex: number
  /** Whether the card is currently being dragged */
  isDragging?: boolean
  /** Callback when edit button is clicked */
  onEdit: (questionId: number) => void
  /** Callback when publish/unpublish is toggled */
  onPublishToggle: (questionId: number, isPublished: boolean) => void
  /** Callback when delete is confirmed */
  onDelete: (questionId: number) => void
  /** Whether the card is disabled (e.g., during loading) */
  disabled?: boolean
}

/**
 * Get the appropriate icon based on content type
 */
function getContentTypeIcon(contentType: string) {
  switch (contentType) {
    case ContentType.URL:
      return <Link className="w-3.5 h-3.5" />
    case ContentType.ATTACHMENT:
      return <Paperclip className="w-3.5 h-3.5" />
    case ContentType.MIXED:
      return <Layers className="w-3.5 h-3.5" />
    case ContentType.TEXT:
    default:
      return <FileText className="w-3.5 h-3.5" />
  }
}

/**
 * Get the display label for content type
 */
function getContentTypeLabel(contentType: string, t: (key: string) => string): string {
  switch (contentType) {
    case ContentType.URL:
      return 'URL'
    case ContentType.ATTACHMENT:
      return t('questions.content_types.attachment')
    case ContentType.MIXED:
      return t('questions.content_types.mixed')
    case ContentType.TEXT:
    default:
      return t('questions.content_types.text')
  }
}

/**
 * Get content preview from question content_data
 */
function getContentPreview(
  contentData: Record<string, unknown>,
  t: (key: string) => string
): string {
  if (typeof contentData.text === 'string' && contentData.text) {
    return contentData.text.slice(0, 150)
  }
  if (typeof contentData.url === 'string' && contentData.url) {
    return contentData.url
  }
  if (Array.isArray(contentData.attachments) && contentData.attachments.length > 0) {
    return `${contentData.attachments.length} ${t('questions.attachments')}`
  }
  return t('questions.no_content')
}

/**
 * QuestionCard - Individual sortable question card component
 *
 * Features:
 * - Drag handle for reordering (using @dnd-kit)
 * - Question number, title, and content preview
 * - Content type badge
 * - Status badge (published/draft)
 * - Action buttons: Edit, Publish/Unpublish, Delete
 * - Delete confirmation dialog
 *
 * Design:
 * - White rounded-2xl card with border
 * - Hover effects: shadow and slight translate
 * - Dragging state with opacity change
 */
export function QuestionCard({
  question,
  displayIndex,
  onEdit,
  onPublishToggle,
  onDelete,
  disabled = false,
}: QuestionCardProps) {
  const { t } = useTranslation('evaluation')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const isPublished = question.status === QuestionStatus.PUBLISHED

  // Set up sortable functionality from @dnd-kit
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: question.id,
    disabled,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const handleEdit = () => {
    onEdit(question.id)
  }

  const handlePublishToggle = () => {
    onPublishToggle(question.id, isPublished)
  }

  const handleDeleteClick = () => {
    setShowDeleteDialog(true)
  }

  const handleConfirmDelete = () => {
    onDelete(question.id)
    setShowDeleteDialog(false)
  }

  const contentPreview = getContentPreview(question.content_data, t)

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`
          bg-white rounded-2xl border border-gray-100 shadow-sm
          hover:shadow-md hover:-translate-y-[2px]
          transition-all duration-250
          ${isDragging ? 'opacity-50 shadow-lg ring-2 ring-primary/20' : ''}
          ${disabled ? 'opacity-60 pointer-events-none' : ''}
        `}
      >
        <div className="p-5">
          <div className="flex items-start gap-4">
            {/* Drag Handle */}
            <button
              {...attributes}
              {...listeners}
              className="
                shrink-0 p-1.5 -ml-1.5 rounded-lg
                text-gray-400 hover:text-gray-600 hover:bg-gray-100
                cursor-grab active:cursor-grabbing
                transition-colors
              "
              aria-label={t('questions.drag_to_reorder')}
            >
              <GripVertical className="w-5 h-5" />
            </button>

            {/* Question Number */}
            <div className="shrink-0 w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
              <span className="text-sm font-semibold text-gray-700">{displayIndex}</span>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-gray-900 truncate">
                    {question.title}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1 line-clamp-2">{contentPreview}</p>
                </div>

                {/* Badges */}
                <div className="shrink-0 flex items-center gap-2">
                  <Badge variant="secondary" className="flex items-center gap-1 text-xs">
                    {getContentTypeIcon(question.content_type)}
                    <span>{getContentTypeLabel(question.content_type, t)}</span>
                  </Badge>
                  <Badge variant={isPublished ? 'success' : 'secondary'} className="text-xs">
                    {isPublished ? t('topics.published') : t('topics.unpublished')}
                  </Badge>
                </div>
              </div>

              {/* Meta info */}
              <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
                <span>
                  {t('common:version')} {question.current_version}
                </span>
                <span>•</span>
                <span>
                  {t('common:updated')} {new Date(question.updated_at).toLocaleDateString()}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="shrink-0 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleEdit}
                className="h-8 w-8 p-0 text-gray-500 hover:text-gray-700"
              >
                <Pencil className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handlePublishToggle}
                className="h-8 w-8 p-0 text-gray-500 hover:text-gray-700"
              >
                {isPublished ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteClick}
                className="h-8 w-8 p-0 text-gray-500 hover:text-red-600"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('questions.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('questions.delete_description', { title: question.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
