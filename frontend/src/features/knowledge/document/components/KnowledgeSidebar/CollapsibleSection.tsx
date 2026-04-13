// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * CollapsibleSection - A collapsible section with header and content.
 *
 * Used for Favorites, Recent, and Groups sections in the sidebar.
 */

'use client'

import { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CollapsibleSectionProps {
  /** Section title */
  title: string
  /** Icon to display before title */
  icon?: ReactNode
  /** Whether the section is expanded */
  isExpanded: boolean
  /** Toggle expand/collapse */
  onToggle: () => void
  /** Optional count badge */
  count?: number
  /** Optional action button on the right */
  action?: ReactNode
  /** Section content */
  children: ReactNode
  /** Additional class name */
  className?: string
  /** Test ID for the section */
  testId?: string
}

export function CollapsibleSection({
  title,
  icon,
  isExpanded,
  onToggle,
  count,
  action,
  children,
  className,
  testId,
}: CollapsibleSectionProps) {
  return (
    <div className={cn('border-b border-border', className)} data-testid={testId}>
      {/* Header */}
      <div
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium
                   text-text-secondary hover:bg-muted transition-colors"
        data-testid={testId ? `${testId}-header` : undefined}
      >
        {/* Clickable area for expand/collapse */}
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 flex items-center gap-2 min-w-0 text-left"
          aria-expanded={isExpanded}
        >
          {/* Expand/collapse icon */}
          <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </span>

          {/* Section icon */}
          {icon && <span className="flex-shrink-0">{icon}</span>}

          {/* Title */}
          <span className="flex-1 text-left truncate">{title}</span>

          {/* Count badge */}
          {count !== undefined && count > 0 && (
            <span className="flex-shrink-0 text-xs text-text-muted tabular-nums">{count}</span>
          )}
        </button>

        {/* Action button - outside the toggle button to avoid nesting */}
        {action && <span className="flex-shrink-0">{action}</span>}
      </div>

      {/* Content */}
      {isExpanded && <div className="pb-2">{children}</div>}
    </div>
  )
}

export default CollapsibleSection
