// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { memo } from 'react';
import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import type { ThinkingHeaderProps } from '../types';

/**
 * Header component for thinking display panel
 * Shows title, status, tool summary, and expand/collapse button
 */
const ThinkingHeader = memo(function ThinkingHeader({
  title,
  isOpen,
  isCompleted,
  isRunning: _isRunning,
  toolSummary,
  onToggle,
}: ThinkingHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-2 py-2 text-left transition-colors hover:bg-surface/60"
    >
      <div className="flex items-center gap-2">
        <Brain className="text-blue-400 h-4 w-4" />
        <span className={`font-medium text-sm ${isCompleted ? 'text-blue-300' : 'text-blue-400'}`}>
          {title}
        </span>
        {!isOpen && toolSummary && (
          <span className="text-xs text-text-tertiary ml-1">{toolSummary}</span>
        )}
      </div>
      {isOpen ? (
        <ChevronUp className="text-text-tertiary h-4 w-4" />
      ) : (
        <ChevronDown className="text-text-tertiary h-4 w-4" />
      )}
    </button>
  );
});

export default ThinkingHeader;
