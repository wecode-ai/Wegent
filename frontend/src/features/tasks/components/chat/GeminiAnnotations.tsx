// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Gemini Annotations Component
 *
 * Displays grounding annotations from Gemini Deep Research as clickable citation links.
 * Each annotation is displayed on its own line with a numbered index.
 */

import React from 'react'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { GeminiAnnotation } from '@/types/socket'

interface GeminiAnnotationsProps {
  annotations: GeminiAnnotation[]
  className?: string
}

export function GeminiAnnotations({ annotations, className = '' }: GeminiAnnotationsProps) {
  const { t } = useTranslation()

  if (!annotations || annotations.length === 0) {
    return null
  }

  // Extract domain from URL for display
  const getDomain = (url: string): string => {
    try {
      const urlObj = new URL(url)
      return urlObj.hostname.replace('www.', '')
    } catch {
      return url.substring(0, 50)
    }
  }

  // Sort annotations by start_index to maintain consistent order
  const sortedAnnotations = [...annotations].sort((a, b) => a.start_index - b.start_index)

  return (
    <div className={`mt-4 pt-4 border-t border-border ${className}`}>
      <div className="flex items-start gap-2 text-xs text-text-muted">
        <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="font-medium mb-2">{t('chat.sources', 'Sources')}:</div>
          <div className="space-y-1">
            {sortedAnnotations.map((annotation, index) => (
              <div key={`${index}-${annotation.start_index}`} className="flex items-start gap-2">
                <span className="font-mono text-primary font-medium shrink-0">[{index + 1}]</span>
                <a
                  href={annotation.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 hover:underline inline-flex items-center gap-1 max-w-md truncate"
                  title={annotation.source}
                >
                  {getDomain(annotation.source)}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
