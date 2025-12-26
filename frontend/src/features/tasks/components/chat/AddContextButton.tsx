// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';

interface AddContextButtonProps {
  hasSelection: boolean;
  onClick: () => void;
}

/**
 * Add Context Button - matches ModelSelector style
 * Shows "@ Add Context" when no selection, shows "@" only when has selection
 */
export default function AddContextButton({ hasSelection, onClick }: AddContextButtonProps) {
  const { t } = useTranslation('knowledge');

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
        'border transition-colors',
        'border-border bg-base hover:bg-hover',
        'focus:outline-none focus:ring-0'
      )}
    >
      <span className="text-base font-medium text-text-primary flex-shrink-0">@</span>
      {!hasSelection && (
        <span className="truncate text-xs text-text-primary min-w-0">{t('add_context')}</span>
      )}
      <ChevronDown className="h-2.5 w-2.5 text-text-primary flex-shrink-0 opacity-60" />
    </button>
  );
}
