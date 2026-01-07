// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText } from 'lucide-react'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'

export function DocsButton({
  className = '',
  onClick,
  showLabel = false,
}: {
  className?: string
  onClick?: () => void
  showLabel?: boolean
}) {
  const { t } = useTranslation()

  const navigateToDocs = () => {
    // Use window.open to open documentation in new tab
    window.open(paths.docs.getHref(), '_blank')
    onClick?.()
  }

  const baseClassName = showLabel
    ? 'flex items-center gap-3 text-sm text-text-primary hover:bg-muted transition-colors duration-150'
    : 'h-9 px-3 bg-muted border border-border rounded-full flex items-center gap-1 text-sm font-medium text-text-primary hover:bg-border/40 transition-colors duration-200'

  const mergedClassName = `${baseClassName} ${className}`.trim()

  return (
    <button
      type="button"
      onClick={navigateToDocs}
      className={mergedClassName}
      aria-label={t('common:navigation.docs')}
    >
      <FileText className="h-4 w-4 text-text-muted" />
      {showLabel && <span>{t('common:navigation.docs')}</span>}
    </button>
  )
}
