// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

interface MentionAutocompleteProps {
  teamName: string;
  onSelect: (mention: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export default function MentionAutocomplete({
  teamName,
  onSelect,
  onClose,
  position,
}: MentionAutocompleteProps) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement>(null);

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

  const handleSelect = useCallback(() => {
    onSelect(`@${teamName}`);
    onClose();
  }, [teamName, onSelect, onClose]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        handleSelect();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, handleSelect]);

  if (!teamName) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[200px]"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      <div
        className="px-3 py-2 cursor-pointer hover:bg-muted transition-colors flex items-center gap-2"
        onClick={handleSelect}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSelect();
          }
        }}
      >
        <span className="text-base">🤖</span>
        <span className="text-sm text-text-primary font-medium">{teamName}</span>
      </div>
      <div className="px-3 py-1 text-xs text-text-muted border-t border-border">
        {t('groupChat.mentionAutocomplete.title')}
      </div>
    </div>
  );
}
