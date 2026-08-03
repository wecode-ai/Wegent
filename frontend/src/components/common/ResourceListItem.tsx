// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { Tag } from '@/components/ui/tag'
import { cn } from '@/lib/utils'

/**
 * Tag configuration for ResourceListItem
 */
export interface ResourceTag {
  key: string
  label: string
  variant?: 'default' | 'info' | 'success' | 'warning' | 'error'
  className?: string
}

/**
 * Props for ResourceListItem component
 * Used to display resource information in a consistent way across Bot, Model, and Shell lists
 */
export interface ResourceListItemProps {
  /** Unique identifier of the resource */
  name: string
  /** Display name (takes priority over name) */
  displayName?: string
  /** Description text to show below the name */
  description?: string
  /** Secondary identity text shown below the name */
  identity?: React.ReactNode
  /** Whether this is a public resource */
  isPublic?: boolean
  /** Whether to show ID line when displayName differs from name */
  showId?: boolean
  /** Array of tags to display */
  tags?: ResourceTag[]
  /** Icon element (passed from parent) */
  icon?: React.ReactNode
  /** Optional children (e.g., status indicator for bots) */
  children?: React.ReactNode
  /** Optional actions rendered at the right side of the title row */
  actions?: React.ReactNode
  /** Public resource label translation */
  publicLabel?: string
  /** Use the resource-library card hierarchy */
  cardLayout?: boolean
}

/**
 * ResourceListItem component
 * A unified component for displaying resource information in list views
 * Supports theme adaptation and responsive design
 */
export function ResourceListItem({
  name,
  displayName,
  description,
  identity,
  isPublic = false,
  showId = false,
  tags = [],
  icon,
  children,
  actions,
  publicLabel = 'Public',
  cardLayout = false,
}: ResourceListItemProps) {
  const finalDisplayName = displayName || name
  const shouldShowId = showId && displayName && displayName !== name

  return (
    <div
      className={cn('flex min-w-0 flex-1 space-x-3', cardLayout ? 'items-start' : 'items-center')}
    >
      {/* Icon */}
      {icon && <div className="flex-shrink-0">{icon}</div>}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {/* Name row */}
        <div className="flex min-w-0 items-center gap-2">
          <h3
            className={cn(
              'mb-0 min-w-0 truncate text-base text-text-primary',
              cardLayout ? 'font-semibold' : 'font-medium',
              actions && 'flex-1'
            )}
            title={finalDisplayName}
          >
            {finalDisplayName}
          </h3>
          {isPublic && (
            <Tag variant="info" className="shrink-0 whitespace-nowrap text-xs">
              {publicLabel}
            </Tag>
          )}
          {/* Optional children (e.g., status indicator) */}
          {children}
          {actions && (
            <div
              className="ml-auto flex shrink-0 items-center gap-1"
              data-testid="resource-list-item-actions"
            >
              {actions}
            </div>
          )}
        </div>

        {/* ID row (optional) */}
        {shouldShowId && <p className="text-xs text-text-muted truncate">ID: {name}</p>}

        {/* Secondary identity row (optional) */}
        {identity && <div className="mt-1 truncate text-xs text-text-muted">{identity}</div>}

        {/* Description row (optional) */}
        {description && (
          <p
            className={cn(
              'mt-2 text-sm leading-5 text-text-secondary',
              cardLayout ? 'line-clamp-2 min-h-10' : 'truncate'
            )}
          >
            {description}
          </p>
        )}

        {/* Tags row */}
        {tags.length > 0 && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
            {tags.map(tag => (
              <Tag key={tag.key} variant={tag.variant || 'default'} className={tag.className}>
                {tag.label}
              </Tag>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
