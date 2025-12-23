// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState } from 'react';
import AddContextButton from './AddContextButton';
import KnowledgeBaseSelector from './KnowledgeBaseSelector';
import KnowledgeBaseBadge from './KnowledgeBaseBadge';
import type { KnowledgeBase } from '@/types/api';

interface ChatKnowledgeBaseInputProps {
  selectedKnowledgeBases: KnowledgeBase[];
  onKnowledgeBasesChange: (knowledgeBases: KnowledgeBase[]) => void;
}

export default function ChatKnowledgeBaseInput({
  selectedKnowledgeBases,
  onKnowledgeBasesChange,
}: ChatKnowledgeBaseInputProps) {
  const [selectorOpen, setSelectorOpen] = useState(false);

  const handleSelect = (knowledgeBase: KnowledgeBase) => {
    onKnowledgeBasesChange([...selectedKnowledgeBases, knowledgeBase]);
  };

  const handleDeselect = (knowledge_id: string) => {
    onKnowledgeBasesChange(
      selectedKnowledgeBases.filter(kb => kb.knowledge_id !== knowledge_id)
    );
  };

  const handleRemoveBadge = (knowledge_id: string) => {
    handleDeselect(knowledge_id);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <KnowledgeBaseSelector
        open={selectorOpen}
        onOpenChange={setSelectorOpen}
        selectedKnowledgeBases={selectedKnowledgeBases}
        onSelect={handleSelect}
        onDeselect={handleDeselect}
      >
        <div>
          <AddContextButton
            hasSelection={selectedKnowledgeBases.length > 0}
            onClick={() => setSelectorOpen(true)}
          />
        </div>
      </KnowledgeBaseSelector>

      {selectedKnowledgeBases.map(kb => (
        <KnowledgeBaseBadge
          key={kb.knowledge_id}
          knowledgeBase={kb}
          onRemove={() => handleRemoveBadge(kb.knowledge_id)}
        />
      ))}
    </div>
  );
}
