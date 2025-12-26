// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState } from 'react';
import AddContextButton from './AddContextButton';
import ContextSelector from './ContextSelector';
import ContextBadge from './ContextBadge';
import type { ContextItem } from '@/types/context';
import { isChatContextEnabled } from '@/lib/runtime-config';

interface ChatContextInputProps {
  selectedContexts: ContextItem[];
  onContextsChange: (contexts: ContextItem[]) => void;
}

/**
 * Generic context input component for chat
 * Currently supports: knowledge_base
 * Future: person, bot, team
 */
export default function ChatContextInput({
  selectedContexts,
  onContextsChange,
}: ChatContextInputProps) {
  const [selectorOpen, setSelectorOpen] = useState(false);

  const handleSelect = (context: ContextItem) => {
    onContextsChange([...selectedContexts, context]);
  };

  const handleDeselect = (id: number | string) => {
    onContextsChange(selectedContexts.filter(ctx => ctx.id !== id));
  };

  const handleRemoveBadge = (id: number | string) => {
    handleDeselect(id);
  };

  // If chat context feature is disabled, don't render anything
  if (!isChatContextEnabled()) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <ContextSelector
        open={selectorOpen}
        onOpenChange={setSelectorOpen}
        selectedContexts={selectedContexts}
        onSelect={handleSelect}
        onDeselect={handleDeselect}
      >
        <div>
          <AddContextButton
            hasSelection={selectedContexts.length > 0}
            onClick={() => setSelectorOpen(true)}
          />
        </div>
      </ContextSelector>

      {selectedContexts.map(ctx => (
        <ContextBadge
          key={`${ctx.type}-${ctx.id}`}
          context={ctx}
          onRemove={() => handleRemoveBadge(ctx.id)}
        />
      ))}
    </div>
  );
}
