// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { X, FileText } from 'lucide-react';
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
  const Icon = getContextIcon(context.type);

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary/10 text-primary px-2.5 py-2.5 text-xs font-medium max-w-[200px] h-9">
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{context.name}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 p-0.5 rounded-full hover:bg-primary/20 transition-colors flex-shrink-0"
        aria-label="Remove"
      >
        <X className="w-4 h-4" />
      </button>
    </span>
  );
}
