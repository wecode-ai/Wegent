// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { MessageSquare, FileText } from 'lucide-react'

interface PoweredByFooterProps {
  className?: string
}

/**
 * Footer component that displays docs link, feedback link and "Powered by AI应用平台" branding
 * Used on home page and task pages (when no task is selected)
 */
export default function PoweredByFooter({ className = '' }: PoweredByFooterProps) {
  const { t } = useTranslation('common')

  const handleDocsClick = () => {
    const docsUrl = process.env.NEXT_PUBLIC_DOCS_URL || 'https://wecode-ai.github.io/wegent-docs'
    window.open(docsUrl, '_blank')
  }

  const handleFeedbackClick = () => {
    const feedbackUrl =
      process.env.NEXT_PUBLIC_FEEDBACK_URL || 'https://github.com/wecode-ai/wegent/issues/new'
    window.open(feedbackUrl, '_blank')
  }

  return (
    <div
      className={`fixed bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-3 pointer-events-none flex-nowrap whitespace-nowrap ${className}`}
    >
      <button
        type="button"
        onClick={handleDocsClick}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors pointer-events-auto"
      >
        <FileText className="h-3 w-3" />
        <span>{t('navigation.docs')}</span>
      </button>
      <span className="text-xs text-text-muted">·</span>
      <button
        type="button"
        onClick={handleFeedbackClick}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors pointer-events-auto"
      >
        <MessageSquare className="h-3 w-3" />
        <span>{t('navigation.feedback')}</span>
      </button>
      <span className="text-xs text-text-muted">·</span>
      <a
        href="https://aigc.intra.weibo.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-text-muted hover:text-text-secondary transition-colors pointer-events-auto"
      >
        {t('footer.powered_by')}
      </a>
    </div>
  )
}
