// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ArrowLeft, ClipboardCheck, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface GraderHeaderProps {
  title: string
  description?: string
  onBack?: () => void
  onRefresh?: () => void
  isLoading?: boolean
  backHref?: string
  actions?: React.ReactNode
}

/**
 * GraderHeader Component
 *
 * A sticky header component for grader pages.
 * Features:
 * - Back button to return to previous page
 * - Title with icon
 * - Refresh button
 * - Custom actions slot
 *
 * Design inspired by TopicHeader from author pages
 * Uses consistent styling with evaluation module
 */
export function GraderHeader({
  title,
  description,
  onBack,
  onRefresh,
  isLoading = false,
  backHref,
  actions,
}: GraderHeaderProps) {
  const { t } = useTranslation('evaluation')

  const handleBack = () => {
    if (onBack) {
      onBack()
    } else if (backHref) {
      window.location.href = backHref
    }
  }

  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
        {/* Left side: Back button and title */}
        <div className="flex items-center gap-3 min-w-0">
          {(onBack || backHref) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="shrink-0 h-9 w-9 p-0"
              aria-label={t('actions.back')}
            >
              <ArrowLeft className="h-5 w-5 text-gray-600" />
            </Button>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-gray-400 shrink-0" />
              <h1 className="text-lg font-bold text-gray-900 truncate">{title}</h1>
            </div>
            {description && (
              <p className="text-xs text-gray-400 truncate max-w-md hidden sm:block">
                {description}
              </p>
            )}
          </div>
        </div>

        {/* Right side: Actions */}
        <div className="flex items-center gap-2">
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
              className="shrink-0 border-gray-200 hover:bg-gray-50"
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('common:actions.refresh')}</span>
            </Button>
          )}
          {actions}
        </div>
      </div>
    </header>
  )
}
