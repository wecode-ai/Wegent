// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from './ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'

export function ThemeToggle({
  className = '',
  onToggle,
  showLabel = false,
}: {
  className?: string
  onToggle?: () => void
  showLabel?: boolean
}) {
  const { theme, toggleTheme } = useTheme()
  const { t } = useTranslation()
  const isDark = theme === 'dark'

  const baseClassName = showLabel
    ? 'flex items-center gap-3 text-sm text-text-primary hover:bg-muted transition-colors duration-150'
    : 'h-8 w-8 bg-base border border-border rounded-[7px] flex items-center justify-center text-text-primary hover:bg-hover transition-colors duration-200'

  const mergedClassName = `${baseClassName} ${className}`.trim()

  const Icon = isDark ? Sun : Moon
  const label = isDark ? t('common:theme.light', 'Light Mode') : t('common:theme.dark', 'Dark Mode')

  const handleClick = () => {
    // Execute callback to close menu first, then toggle theme to avoid flicker
    onToggle?.()
    toggleTheme()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={mergedClassName}
      aria-label={t('common:actions.toggle_theme')}
    >
      <Icon className="h-3.5 w-3.5" />
      {showLabel && <span>{label}</span>}
    </button>
  )
}
