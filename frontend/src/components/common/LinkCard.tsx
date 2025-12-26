// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback } from 'react'
import { ExternalLink, Globe, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUrlMetadata } from '@/hooks/useUrlMetadata'
import { extractDomain, formatDisplayUrl } from '@/utils/url-detector'

interface LinkCardProps {
  /** The URL to display */
  url: string
  /** Optional display text (from markdown link) */
  displayText?: string
  /** Optional CSS class name */
  className?: string
}

/**
 * Link card component for displaying webpage URL previews
 * Fetches metadata (title, description, favicon) from backend API
 * Falls back to simple link display on error
 */
export default function LinkCard({ url, displayText, className }: LinkCardProps) {
  const { metadata, isLoading, error } = useUrlMetadata(url)
  const [imageError, setImageError] = useState(false)

  const handleClick = useCallback(() => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [url])

  const handleFaviconError = useCallback(() => {
    setImageError(true)
  }, [])

  const domain = extractDomain(url)

  // Loading state
  if (isLoading) {
    return (
      <div
        className={cn(
          'flex items-center gap-3 p-3 rounded-lg',
          'bg-surface border border-border',
          'cursor-pointer hover:border-primary hover:bg-surface/80',
          'transition-all duration-200',
          'max-w-md',
          className
        )}
        onClick={handleClick}
      >
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="h-4 bg-muted rounded animate-pulse w-3/4 mb-2" />
          <div className="h-3 bg-muted rounded animate-pulse w-1/2" />
        </div>
      </div>
    )
  }

  // Error state or no metadata - show simple link
  if (error || !metadata?.success) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex items-center gap-2 px-3 py-2 rounded-lg',
          'bg-surface border border-border hover:border-primary',
          'text-sm text-link hover:underline transition-colors',
          'max-w-md',
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Globe className="h-4 w-4 text-text-muted flex-shrink-0" />
        <span className="truncate">{displayText || formatDisplayUrl(url)}</span>
        <ExternalLink className="h-3 w-3 text-text-muted flex-shrink-0" />
      </a>
    )
  }

  // Success state - show rich preview card
  const { title, description, favicon } = metadata

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-3 rounded-lg',
        'bg-surface border border-border',
        'cursor-pointer hover:border-primary hover:shadow-sm',
        'transition-all duration-200',
        'max-w-md',
        className
      )}
      onClick={handleClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
    >
      {/* Favicon */}
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
        {favicon && !imageError ? (
          <img
            src={favicon}
            alt=""
            className="w-6 h-6 object-contain"
            onError={handleFaviconError}
          />
        ) : (
          <Globe className="h-5 w-5 text-text-muted" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title */}
        <div className="flex items-start gap-2">
          <h4 className="text-sm font-medium text-text-primary line-clamp-1 flex-1">
            {title || displayText || domain}
          </h4>
          <ExternalLink className="h-3 w-3 text-text-muted flex-shrink-0 mt-1" />
        </div>

        {/* Description */}
        {description && (
          <p className="text-xs text-text-secondary line-clamp-2 mt-1">{description}</p>
        )}

        {/* Domain */}
        <p className="text-xs text-text-muted mt-1">{domain}</p>
      </div>
    </div>
  )
}
