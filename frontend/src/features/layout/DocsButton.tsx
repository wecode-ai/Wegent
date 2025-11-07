// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileTextOutlined } from '@ant-design/icons'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'

export function DocsButton({ className = '', onClick }: { className?: string; onClick?: () => void }) {
  const { t } = useTranslation('common')

  const navigateToDocs = () => {
    // Use window.open to open documentation in new tab
    window.open(paths.docs.getHref(), '_blank')
    onClick?.()
  }

  const mergedClassName = `
    px-3 py-1 bg-muted border border-border rounded-full
    flex items-center gap-1 text-sm font-medium text-text-primary
    hover:bg-border/40 transition-colors duration-200
    ${className}
  `.trim()

  return (
    <button
      type="button"
      onClick={navigateToDocs}
      className={mergedClassName}
      aria-label={t('navigation.docs')}
    >
      <FileTextOutlined className="text-base leading-none" style={{ color: 'var(--text-primary)' }} />
    </button>
  )
}