// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Source References Component
 *
 * Displays knowledge base source references for RAG-enhanced responses.
 * Shows document titles with index numbers (e.g., [1], [2], [3]).
 */

import React from 'react'
import { FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface SourceReference {
  index: number
  title: string
  kb_id: number
}

interface SourceReferencesProps {
  sources: SourceReference[]
  className?: string
}

export function SourceReferences({ sources, className = '' }: SourceReferencesProps) {
  const { t } = useTranslation()

  if (!sources || sources.length === 0) {
    return null
  }

  return (
    <div className={`mt-3 pt-3 border-t border-border ${className}`}>
      <div className="flex items-start gap-2 text-xs text-text-muted">
        <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="font-medium mb-1.5">{t('chat.sourceReferences', '资料来源')}:</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {sources.map(source => (
              <div key={source.index} className="flex items-baseline gap-1">
                <span className="font-mono text-primary">[{source.index}]</span>
                <span className="text-text-secondary">{source.title}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
