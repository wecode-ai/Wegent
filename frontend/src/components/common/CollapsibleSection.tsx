'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * CollapsibleSection - A reusable collapsible section wrapper
 * Used for forms and settings panels that need expandable/collapsible sections
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

interface CollapsibleSectionProps {
  /** Section title displayed in the header */
  title: string
  /** Optional icon to display before the title */
  icon?: React.ReactNode
  /** Whether the section is open by default */
  defaultOpen?: boolean
  /** Section content */
  children: React.ReactNode
  /** Additional CSS classes for the container */
  className?: string
  /** Whether to use primary border color (for emphasis) */
  primary?: boolean
}

export function CollapsibleSection({
  title,
  icon,
  defaultOpen = true,
  children,
  className,
  primary = false,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn('mb-4', className)}>
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          primary ? 'border-primary/40' : 'border-border'
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center justify-between p-4',
              'bg-surface/80 hover:bg-surface transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'
            )}
          >
            <div className="flex items-center gap-2">
              {icon}
              <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            </div>
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-text-muted transition-transform" />
            ) : (
              <ChevronRight className="h-4 w-4 text-text-muted transition-transform" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-4 pt-4 space-y-4 bg-white dark:bg-gray-900">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
