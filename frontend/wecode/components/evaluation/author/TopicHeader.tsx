// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  ArrowLeft,
  Settings,
  GraduationCap,
  Globe,
  Lock,
  FileText,
  Send,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { TopicStatus, TopicVisibility } from '@wecode/types/evaluation'
import type { TopicHeaderProps } from './types'

/**
 * TopicHeader Component
 *
 * A sticky header component for the author topic detail page.
 * Features:
 * - Back button to return to author topics list
 * - Topic name display with truncation
 * - Status badges (visibility, status, exam mode)
 * - Edit configuration button that opens a drawer
 *
 * Design inspired by ExamHeader from ai-assessment-2026
 * Uses red accent color (#DF2029) for primary actions
 */
export function TopicHeader({
  topic,
  onBack,
  onEditConfig,
  onPublish,
  onViewExam,
  isLoading = false,
  isPublishing = false,
}: TopicHeaderProps) {
  const { t } = useTranslation('evaluation')

  // Helper to get visibility badge config
  const getVisibilityBadge = () => {
    if (topic.visibility === TopicVisibility.PUBLIC) {
      return {
        variant: 'default' as const,
        icon: Globe,
        label: t('topics.public'),
      }
    }
    return {
      variant: 'secondary' as const,
      icon: Lock,
      label: t('topics.private'),
    }
  }

  // Helper to get status badge config
  const getStatusBadge = () => {
    if (topic.status === TopicStatus.PUBLISHED) {
      return {
        variant: 'success' as const,
        label: t('topics.published'),
      }
    }
    return {
      variant: 'info' as const,
      label: t('common.draft'),
    }
  }

  const visibilityBadge = getVisibilityBadge()
  const statusBadge = getStatusBadge()
  const VisibilityIcon = visibilityBadge.icon

  // Check if exam mode is enabled from extra_data
  const isExamMode = topic.extra_data?.exam_mode === true

  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
        {/* Left side: Back button and topic info */}
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="shrink-0 h-9 w-9 p-0"
            aria-label={t('actions.back')}
          >
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </Button>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-gray-400 shrink-0" />
              <h1 className="text-[1rem] font-bold text-gray-900 truncate">{topic.name}</h1>
            </div>
            {topic.description && (
              <p className="text-xs text-gray-400 truncate max-w-md hidden sm:block">
                {topic.description}
              </p>
            )}
          </div>
        </div>

        {/* Right side: Badges and actions */}
        <div className="flex items-center gap-3">
          {/* Status badges - hidden on small mobile */}
          <div className="hidden sm:flex items-center gap-2">
            {/* Visibility badge */}
            <Badge variant={visibilityBadge.variant} className="flex items-center gap-1">
              <VisibilityIcon className="h-3 w-3" />
              {visibilityBadge.label}
            </Badge>

            {/* Status badge */}
            <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>

            {/* View exam button - only for published topics */}
            {topic.status === TopicStatus.PUBLISHED && onViewExam && (
              <Button
                variant="outline"
                size="sm"
                onClick={onViewExam}
                disabled={isLoading}
                className="shrink-0 border-emerald-200 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
              >
                <ExternalLink className="mr-1.5 h-4 w-4" />
                {t('exam.start_exam')}
              </Button>
            )}

            {/* Exam mode badge */}
            {isExamMode && (
              <Badge variant="warning" className="flex items-center gap-1">
                <GraduationCap className="h-3 w-3" />
                {t('topics.exam_mode')}
              </Badge>
            )}
          </div>

          {/* Publish button - only show for draft topics */}
          {topic.status === TopicStatus.DRAFT && onPublish && (
            <Button
              size="sm"
              onClick={onPublish}
              disabled={isPublishing || isLoading}
              className="shrink-0 bg-[#DF2029] hover:bg-[#c81d25] text-white"
            >
              {isPublishing ? (
                <>
                  <span className="animate-spin mr-1.5 h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  {t('topics.publishing', 'Publishing...')}
                </>
              ) : (
                <>
                  <Send className="mr-1.5 h-4 w-4" />
                  {t('topics.publish', 'Publish')}
                </>
              )}
            </Button>
          )}

          {/* Edit configuration button */}
          <Button
            variant="outline"
            size="sm"
            onClick={onEditConfig}
            disabled={isLoading}
            className="shrink-0 border-gray-200 hover:bg-gray-50"
          >
            <Settings className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">{t('actions.config')}</span>
            <span className="sm:hidden">{t('common:actions.edit')}</span>
          </Button>
        </div>
      </div>

      {/* Mobile badges row - shown only on small screens */}
      <div className="sm:hidden px-4 pb-3 flex items-center gap-2 flex-wrap">
        <Badge variant={visibilityBadge.variant} size="sm" className="flex items-center gap-1">
          <VisibilityIcon className="h-3 w-3" />
          {visibilityBadge.label}
        </Badge>
        <Badge variant={statusBadge.variant} size="sm">
          {statusBadge.label}
        </Badge>
        {isExamMode && (
          <Badge variant="warning" size="sm" className="flex items-center gap-1">
            <GraduationCap className="h-3 w-3" />
            {t('topics.exam_mode')}
          </Badge>
        )}
      </div>
    </header>
  )
}
