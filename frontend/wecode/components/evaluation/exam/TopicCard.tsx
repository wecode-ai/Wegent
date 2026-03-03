// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, FileText } from 'lucide-react'
import type { Question } from '@wecode/types/evaluation'
import { cn } from '@/lib/utils'

/**
 * Props for the TopicCard component
 */
interface TopicCardProps {
  /** Question identifier for display */
  questionId: number
  /** Topic title */
  title: string
  /** Question content data */
  content: Question['content_data']
  /** Whether this card is currently selected */
  selected: boolean
  /** Click handler for card selection */
  onClick: () => void
  /** Whether the card is disabled */
  disabled?: boolean
}

/**
 * Helper to safely get string value from content data
 */
function getStringValue(
  content: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!content) return undefined
  const value = content[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Card component for displaying exam topic selection.
 * Shows topic information with visual selection state.
 *
 * Features:
 * - Visual selection indicator with checkmark animation
 * - Hover and disabled states
 * - Smooth transitions
 *
 * @example
 * ```tsx
 * <TopicCard
 *   questionId={1}
 *   title="AI Agent Development"
 *   content={questionContent}
 *   selected={selectedId === 1}
 *   onClick={() => setSelectedId(1)}
 * />
 * ```
 */
export function TopicCard({
  questionId,
  title,
  content,
  selected,
  onClick,
  disabled,
}: TopicCardProps) {
  const shortDesc = getStringValue(content, 'shortDesc') || ''

  return (
    <div
      className={cn(
        'relative rounded-2xl border-2 p-7 cursor-pointer bg-white transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
        selected
          ? 'border-[#DF2029] shadow-[0_0_0_3px_rgba(223,32,41,0.12),0_8px_24px_-6px_rgba(223,32,41,0.15)]'
          : disabled
            ? 'border-gray-100 opacity-40'
            : 'border-gray-100 hover:border-gray-200 hover:-translate-y-[3px] hover:shadow-[0_12px_28px_-8px_rgba(0,0,0,0.12)]'
      )}
      onClick={disabled ? undefined : onClick}
    >
      {selected && (
        <div className="absolute top-5 right-5 w-7 h-7 rounded-full bg-[#DF2029] flex items-center justify-center animate-[checkPop_0.4s_ease-out]">
          <Check className="w-4 h-4 text-white" strokeWidth={3} />
        </div>
      )}
      <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 bg-violet-50">
        <FileText className="w-6 h-6 text-violet-600" />
      </div>
      <span className="inline-block text-sm font-semibold px-2.5 py-1 rounded-full mb-3 bg-violet-100 text-violet-700">
        题目{questionId}
      </span>
      <h3 className="text-lg font-bold text-gray-900 leading-snug mb-2">{title}</h3>
      <p className="text-base text-gray-500 leading-relaxed">{shortDesc}</p>
    </div>
  )
}
