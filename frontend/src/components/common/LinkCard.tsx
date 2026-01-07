// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo } from 'react'
import { ExternalLink, Globe, Loader2 } from 'lucide-react'
import { useUrlMetadata } from '@/hooks/useUrlMetadata'

interface LinkCardProps {
  /** The URL to display as a card */
  url: string
  /** Optional link text (from Markdown syntax) - now deprecated, original text shown separately */
  linkText?: string
  /** Whether to show a compact version */
  compact?: boolean
  /**
   * Whether to disable metadata fetching.
   * When true, renders as a simple link without fetching metadata.
   * Useful during streaming to avoid excessive API calls.
   */
  disabled?: boolean
}

/**
 * Extract domain from URL for display
 */
function getDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * LinkCard component for rendering web page URLs as rich preview cards.
 * Fetches metadata (title, description, favicon) from the backend API.
 * Falls back to a simple link on error.
 *
 * @param disabled - When true, skips metadata fetching and renders as simple link.
 *                   Use this during streaming to avoid excessive API calls.
 */
export default function LinkCard({
  url,
  linkText,
  compact = false,
  disabled = false,
}: LinkCardProps) {
  // Only fetch metadata when not disabled
  const { metadata, isLoading, error } = useUrlMetadata(disabled ? '' : url)
  const domain = useMemo(() => getDomain(url), [url])

  // Simple link fallback
  const SimpleLinkFallback = () => (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-primary hover:underline hover:!decoration-current text-sm break-all"
    >
      <Globe className="h-4 w-4 flex-shrink-0" />
      <span>{linkText || url}</span>
      <ExternalLink className="h-3 w-3 flex-shrink-0" />
    </a>
  )
  // When disabled, just render as simple link
  if (disabled) {
    return <SimpleLinkFallback />
  }

  // Loading state
  if (isLoading) {
    if (compact) {
      return (
        <span className="inline-flex items-center gap-1.5 text-text-muted text-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="truncate max-w-[200px]">{linkText || domain}</span>
        </span>
      )
    }

    // Use span-based layout to avoid HTML nesting issues (div inside p)
    // Full width with max-width constraint for consistent sizing
    return (
      <span className="block my-2 p-3 rounded-lg border border-border bg-surface animate-pulse w-full max-w-full">
        <span className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-lg bg-muted inline-block flex-shrink-0" />
          <span className="flex-1 min-w-0 space-y-2 inline-block">
            <span className="block h-4 bg-muted rounded w-3/4" />
            <span className="block h-3 bg-muted rounded w-full" />
            <span className="block h-3 bg-muted rounded w-1/3" />
          </span>
        </span>
      </span>
    )
  }

  // Error state or no metadata - fallback to simple link
  if (error || !metadata?.success) {
    return <SimpleLinkFallback />
  }

  // Compact mode
  if (compact) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-primary hover:underline hover:!decoration-current text-sm"
      >
        {metadata.favicon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={metadata.favicon}
            alt=""
            className="w-4 h-4 rounded-sm"
            onError={e => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <Globe className="h-4 w-4 flex-shrink-0" />
        )}
        <span className="truncate max-w-[200px]">{metadata.title || linkText || domain}</span>
        <ExternalLink className="h-3 w-3 flex-shrink-0" />
      </a>
    )
  }

  // Full card display - use span-based layout to avoid HTML nesting issues (div/h4 inside p)
  // Full width with consistent styling, adapts to container (works well in tables)
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block my-2 p-3 rounded-lg border border-border bg-surface hover:bg-muted/50 hover:border-primary/50 hover:!no-underline transition-all group w-full max-w-full"
    >
      <span className="flex items-start gap-3">
        {/* Favicon */}
        <span className="flex-shrink-0 w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
          {metadata.favicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={metadata.favicon}
              alt=""
              className="w-6 h-6 object-contain"
              onError={e => {
                const img = e.target as HTMLImageElement
                img.style.display = 'none'
                // Show fallback icon
                const parent = img.parentElement
                if (parent) {
                  const icon = document.createElement('span')
                  icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-text-muted"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`
                  parent.appendChild(icon)
                }
              }}
            />
          ) : (
            <Globe className="w-5 h-5 text-text-muted" />
          )}
        </span>

        {/* Content */}
        <span className="flex-1 min-w-0 space-y-1 inline-block">
          {/* Title - use span instead of h4 to avoid nesting issues */}
          <span className="block text-sm font-medium text-text-primary truncate group-hover:text-primary transition-colors">
            {metadata.title || linkText || domain}
          </span>

          {/* Description - use span instead of p to avoid nesting issues */}
          {metadata.description && (
            <span className="block text-xs text-text-muted line-clamp-2">
              {metadata.description}
            </span>
          )}

          {/* Domain */}
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <span className="truncate">{domain}</span>
            <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </span>
        </span>
      </span>
    </a>
  )
}
