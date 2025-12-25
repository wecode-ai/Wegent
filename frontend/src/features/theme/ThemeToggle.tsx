// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

  const Icon = isDark ? Sun : Moon;
  const label = isDark ? t('theme.light', 'Light Mode') : t('theme.dark', 'Dark Mode');

  const handleClick = () => {
    // Execute callback to close menu first, then toggle theme to avoid flicker
    onToggle?.();
    toggleTheme();
  };

  if (showLabel) {
    return (
      <Button
        type="button"
        onClick={handleClick}
        variant="ghost"
        size="sm"
        className={`justify-start gap-3 text-sm ${className}`}
        aria-label={t('actions.toggle_theme')}
      >
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      onClick={handleClick}
      variant="ghost"
      size="icon"
      className={`h-8 w-8 bg-base border border-border hover:bg-hover ${className}`}
      aria-label={t('actions.toggle_theme')}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}
