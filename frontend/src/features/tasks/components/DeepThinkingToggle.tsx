// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';

interface DeepThinkingToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

export default function DeepThinkingToggle({
  enabled,
  onToggle,
  disabled = false,
}: DeepThinkingToggleProps) {
  const { i18n } = useTranslation('chat');

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(!enabled);
  };

  // Get text based on language
  const text = i18n.language?.startsWith('zh') ? '深度思考' : 'Deep Thinking';

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggle}
      disabled={disabled}
      className={cn(
        'h-6 px-2 text-xs rounded-md flex-shrink-0 transition-colors',
        enabled
          ? 'bg-primary/10 text-primary hover:bg-primary/20'
          : 'text-text-muted hover:bg-surface hover:text-text-primary'
      )}
    >
      {text}
    </Button>
  );
}
