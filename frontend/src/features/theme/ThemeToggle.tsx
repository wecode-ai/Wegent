// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { MoonOutlined, SunOutlined } from '@ant-design/icons'
import { useTheme } from './ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme()
  const { t } = useTranslation('common')
  const isDark = theme === 'dark'

  const mergedClassName = `
    px-3 py-1 bg-muted border border-border rounded-full
    flex items-center gap-1 text-sm font-medium text-text-primary
    hover:bg-border/40 transition-colors duration-200
    ${className}
  `.trim()

  const Icon = isDark ? SunOutlined : MoonOutlined

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={mergedClassName}
      aria-label={t('actions.toggle_theme')}
    >
      <Icon className="text-base leading-none" style={{ color: 'var(--text-primary)' }} />
      <span>{t('actions.toggle_theme')}</span>
    </button>
  )
}