// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react'
import type { ExtractedContent } from '@shared/extractor'
import { getContentPreview } from '@shared/extractor'

interface ContentPreviewProps {
  content: ExtractedContent | null
  extractionMode: 'selection' | 'fullPage'
  onModeChange: (mode: 'selection' | 'fullPage') => void
  isLoading: boolean
  error: string | null
  isPendingAction?: boolean
}

function ContentPreview({
  content,
  extractionMode,
  onModeChange,
  isLoading,
  error,
  isPendingAction,
}: ContentPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const preview = content ? getContentPreview(content.text, 300) : ''

  return (
    <div className="border-b border-border px-4 py-3">
      {/* Page Info */}
      <div className="mb-2 flex items-center gap-2">
        <svg
          className="h-4 w-4 flex-shrink-0 text-text-secondary"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <span className="text-sm font-medium text-text-primary">Current Page</span>
      </div>

      {content && (
        <div className="mb-3 rounded-lg bg-surface p-2">
          <p className="truncate text-sm font-medium text-text-primary">
            {content.metadata.title}
          </p>
          <p className="truncate text-xs text-text-muted">{content.metadata.url}</p>
        </div>
      )}

      {/* Mode Toggle - Hide when pending action */}
      {!isPendingAction && (
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => onModeChange('selection')}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              extractionMode === 'selection'
                ? 'bg-primary/10 text-primary'
                : 'bg-surface text-text-secondary hover:bg-surface hover:text-text-primary'
            }`}
          >
            Selected Text
          </button>
          <button
            onClick={() => onModeChange('fullPage')}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              extractionMode === 'fullPage'
                ? 'bg-primary/10 text-primary'
                : 'bg-surface text-text-secondary hover:bg-surface hover:text-text-primary'
            }`}
          >
            Full Page
          </button>
        </div>
      )}

      {/* Content Preview */}
      <div
        className={`overflow-hidden rounded-lg border border-border bg-base transition-all ${
          isExpanded ? 'max-h-48' : 'max-h-20'
        }`}
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="ml-2 text-sm text-text-secondary">Extracting...</span>
          </div>
        ) : error ? (
          <div className="p-3 text-sm text-red-600">{error}</div>
        ) : content ? (
          <pre className="whitespace-pre-wrap p-3 text-xs text-text-secondary">
            {isExpanded ? content.text : preview}
          </pre>
        ) : (
          <div className="p-3 text-sm text-text-muted">
            No content available. Select text on the page or switch to Full Page mode.
          </div>
        )}
      </div>

      {/* Expand/Collapse button */}
      {content && content.text.length > 300 && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

export default ContentPreview
