// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { ChevronDown, Hand } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { GuidanceBlock as GuidanceBlockType } from '../types'

interface GuidanceBlockProps {
  block: GuidanceBlockType
}

export function GuidanceBlock({ block }: GuidanceBlockProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div
      data-testid="guidance-block"
      className="overflow-hidden rounded-lg border border-primary/20 bg-primary/5"
    >
      <button
        type="button"
        data-testid="guidance-block-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-primary/10"
        onClick={() => setIsExpanded(open => !open)}
        aria-expanded={isExpanded}
      >
        <Hand className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 font-medium text-text-primary">
          {t('guidance.applied') || '引导已生效'}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      {isExpanded && (
        <div className="border-t border-primary/15 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-5 text-text-secondary">
            {block.content}
          </pre>
        </div>
      )}
    </div>
  )
}

export default GuidanceBlock
