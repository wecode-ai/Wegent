// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Tag } from '@/components/ui/tag';

/**
 * Tag configuration for ResourceListItem
 */
export interface ResourceTag {
  key: string;
  label: string;
  variant?: 'default' | 'info' | 'success' | 'warning' | 'error';
  className?: string;
}

/**
 * Props for ResourceListItem component
 * Used to display resource information in a consistent way across Bot, Model, and Shell lists
 */
export interface ResourceListItemProps {
  /** Unique identifier of the resource */
  name: string;
  /** Display name (takes priority over name) */
  displayName?: string;
  /** Description text to show below the name */
  description?: string;
  /** Whether this is a public resource */
  isPublic?: boolean;
  /** Whether to show ID line when displayName differs from name */
  showId?: boolean;
  /** Array of tags to display */
  tags?: ResourceTag[];
  /** Icon element (passed from parent) */
  icon?: React.ReactNode;
  /** Optional children (e.g., status indicator for bots) */
  children?: React.ReactNode;
  /** Public resource label translation */
  publicLabel?: string;
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
  isPublic = false,
  showId = false,
  tags = [],
  icon,
  children,
  publicLabel = 'Public',
}: ResourceListItemProps) {
  const finalDisplayName = displayName || name;
  const shouldShowId = showId && displayName && displayName !== name;

  return (
    <div className="flex items-center space-x-3 min-w-0 flex-1">
      {/* Icon */}
      {icon && <div className="flex-shrink-0">{icon}</div>}

      {/* Content column */}
      <div className="flex flex-col justify-center min-w-0 flex-1">
        {/* Name row */}
        <div className="flex items-center space-x-2 min-w-0">
          <h3 className="text-base font-medium text-text-primary mb-0 truncate">
            {finalDisplayName}
          </h3>
          {isPublic && (
            <Tag variant="info" className="text-xs">
              {publicLabel}
            </Tag>
          )}
          {/* Optional children (e.g., status indicator) */}
          {children}
        </div>

        {/* ID row (optional) */}
        {shouldShowId && <p className="text-xs text-text-muted truncate">ID: {name}</p>}

        {/* Description row (optional) */}
        {description && <p className="text-sm text-text-muted mt-1 truncate">{description}</p>}

        {/* Tags row */}
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 min-w-0">
            {tags.map(tag => (
              <Tag key={tag.key} variant={tag.variant || 'default'} className={tag.className}>
                {tag.label}
              </Tag>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
