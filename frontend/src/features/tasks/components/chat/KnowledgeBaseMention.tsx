// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Database } from 'lucide-react';
import type { AccessibleKnowledgeBase, TeamKnowledgeGroup } from '@/types/knowledge';

export interface SelectedKnowledgeBase {
  id: number;
  name: string;
}

interface KnowledgeBaseMentionProps {
  personal: AccessibleKnowledgeBase[];
  team: TeamKnowledgeGroup[];
  query?: string;
  onSelect: (knowledgeBase: SelectedKnowledgeBase) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export default function KnowledgeBaseMention({
  personal,
  team,
  query = '',
  onSelect,
  onClose,
  position,
}: KnowledgeBaseMentionProps) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Flatten all knowledge bases for filtering
  const allKnowledgeBases = useMemo(() => {
    const bases: Array<AccessibleKnowledgeBase & { source: 'personal' | 'team'; groupName?: string }> = [];

    // Add personal knowledge bases
    personal.forEach(kb => {
      bases.push({ ...kb, source: 'personal' });
    });

    // Add team knowledge bases
    team.forEach(group => {
      group.knowledge_bases.forEach(kb => {
        bases.push({ ...kb, source: 'team', groupName: group.group_display_name || group.group_name });
      });
    });

    return bases;
  }, [personal, team]);

  // Filter knowledge bases based on query
  const filteredKnowledgeBases = useMemo(() => {
    if (!query || query.trim() === '') {
      return allKnowledgeBases;
    }

    const lowerQuery = query.toLowerCase();
    return allKnowledgeBases.filter(kb => kb.name.toLowerCase().includes(lowerQuery));
  }, [allKnowledgeBases, query]);

  // Reset selected index when filtered bases change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredKnowledgeBases]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const handleSelect = useCallback(
    (kb: AccessibleKnowledgeBase) => {
      onSelect({ id: kb.id, name: kb.name });
      onClose();
    },
    [onSelect, onClose]
  );

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(prev => Math.min(prev + 1, filteredKnowledgeBases.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        if (filteredKnowledgeBases[selectedIndex]) {
          handleSelect(filteredKnowledgeBases[selectedIndex]);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true); // Use capture phase
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose, filteredKnowledgeBases, selectedIndex, handleSelect]);

  if (filteredKnowledgeBases.length === 0) {
    return (
      <div
        ref={menuRef}
        className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-2 px-3 min-w-[200px]"
        style={{
          bottom: `calc(100% - ${position.top}px)`,
          left: `${position.left}px`,
        }}
      >
        <div className="text-sm text-text-muted">{t('knowledgeBase.noResults', 'No knowledge bases found')}</div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[250px] max-h-[300px] overflow-y-auto"
      style={{
        bottom: `calc(100% - ${position.top}px)`,
        left: `${position.left}px`,
      }}
    >
      {filteredKnowledgeBases.map((kb, index) => (
        <div
          key={`kb-${kb.id}`}
          className={`px-3 py-2 cursor-pointer transition-colors flex items-start gap-2 ${
            index === selectedIndex ? 'bg-muted' : 'hover:bg-muted'
          }`}
          onClick={() => handleSelect(kb)}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelect(kb);
            }
          }}
        >
          <Database className="w-4 h-4 text-text-secondary mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary font-medium truncate">{kb.name}</div>
            {kb.source === 'team' && kb.groupName && (
              <div className="text-xs text-text-muted truncate">{kb.groupName}</div>
            )}
            {kb.description && (
              <div className="text-xs text-text-secondary truncate mt-0.5">{kb.description}</div>
            )}
            <div className="text-xs text-text-muted mt-0.5">
              {kb.document_count} {kb.document_count === 1 ? 'document' : 'documents'}
            </div>
          </div>
        </div>
      ))}
      <div className="px-3 py-1 text-xs text-text-muted border-t border-border mt-1">
        {t('knowledgeBase.mentionHint', 'Type @ to reference knowledge bases')}
      </div>
    </div>
  );
}
