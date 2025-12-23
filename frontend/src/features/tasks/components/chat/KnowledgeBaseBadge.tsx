// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { KnowledgeBase } from '@/types/api';

interface KnowledgeBaseBadgeProps {
  knowledgeBase: KnowledgeBase;
  onRemove: () => void;
}

export default function KnowledgeBaseBadge({ knowledgeBase, onRemove }: KnowledgeBaseBadgeProps) {
  return (
    <Badge
      variant="default"
      size="default"
      className="bg-primary text-white gap-1.5 max-w-[200px]"
    >
      <span className="truncate">{knowledgeBase.name}</span>
      <button
        onClick={onRemove}
        className="hover:bg-white/20 rounded-sm p-0.5 transition-colors"
        aria-label="Remove"
      >
        <X className="w-3 h-3" />
      </button>
    </Badge>
  );
}
