// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { X, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import type { ContextItem } from '@/types/context';

interface ContextBadgeProps {
  context: ContextItem;
  onRemove: () => void;
}

/**
 * Get icon component based on context type
 */
const getContextIcon = (type: ContextItem['type']) => {
  switch (type) {
    case 'knowledge_base':
      return FileText;
    // Future context types will be added here
    // case 'person': return User;
    // case 'bot': return Bot;
    // case 'team': return Users;
    default:
      return FileText;
  }
};
export default function ContextBadge({ context, onRemove }: ContextBadgeProps) {
  const { t } = useTranslation('knowledge');
  const Icon = getContextIcon(context.type);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-primary bg-primary/10 text-primary">
      <Icon className="h-4 w-4 flex-shrink-0" />
      <div className="flex flex-col min-w-0 max-w-[150px]">
        <span className="text-xs font-medium truncate" title={context.name}>
          {context.name}
        </span>
        {context.type === 'knowledge_base' && context.document_count !== undefined && (
          <span className="text-xs text-primary/70">
            {t('documents_count', { count: context.document_count })}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="h-5 w-5 ml-1 text-primary hover:text-primary hover:bg-primary/20"
        aria-label={`Remove ${context.name}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
