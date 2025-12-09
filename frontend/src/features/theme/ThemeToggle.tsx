// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { useTranslation } from '@/hooks/useTranslation';

export function ThemeToggle({
  className = '',
  onToggle,
  showLabel = false,
}: {
  className?: string;
  onToggle?: () => void;
  showLabel?: boolean;
}) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation('common');
  const isDark = theme === 'dark';

  const baseClassName = showLabel
    ? 'flex items-center gap-3 text-sm text-text-primary hover:bg-muted transition-colors duration-150'
    : 'px-3 py-1 bg-muted border border-border rounded-full flex items-center gap-1 text-sm font-medium text-text-primary hover:bg-border/40 transition-colors duration-200';

  const mergedClassName = `${baseClassName} ${className}`.trim();

  const Icon = isDark ? Sun : Moon;
  const label = isDark ? t('theme.light', 'Light Mode') : t('theme.dark', 'Dark Mode');

  const handleClick = () => {
    // Execute callback to close menu first, then toggle theme to avoid flicker
    onToggle?.();
    toggleTheme();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={mergedClassName}
      aria-label={t('actions.toggle_theme')}
    >
      <Icon className="h-4 w-4 text-text-muted" />
      {showLabel && <span>{label}</span>}
    </button>
  );
}
