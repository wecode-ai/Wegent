// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { MessageSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function FeedbackButton({
  className = '',
  onClick,
  showLabel = false,
}: {
  className?: string
  onClick?: () => void
  showLabel?: boolean
}) {
  const { t } = useTranslation()

  const navigateToFeedback = () => {
    // Get feedback URL from environment variable or use default
    const feedbackUrl =
      process.env.NEXT_PUBLIC_FEEDBACK_URL || 'https://github.com/wecode-ai/wegent/issues/new'
    // Open feedback link in new tab
    window.open(feedbackUrl, '_blank')
    onClick?.()
  }

  const baseClassName = showLabel
    ? 'flex items-center gap-3 text-sm text-text-primary hover:bg-muted transition-colors duration-150'
    : 'h-9 px-3 bg-muted border border-border rounded-full flex items-center gap-1 text-sm font-medium text-text-primary hover:bg-border/40 transition-colors duration-200'

  const mergedClassName = `${baseClassName} ${className}`.trim()

  return (
    <button
      type="button"
      onClick={navigateToFeedback}
      className={mergedClassName}
      aria-label={t('common:navigation.feedback')}
    >
      <MessageSquare className="h-4 w-4 text-text-muted" />
      {showLabel && <span>{t('common:navigation.feedback')}</span>}
    </button>
  )
}
