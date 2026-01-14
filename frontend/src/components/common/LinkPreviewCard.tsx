// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo } from 'react'
import { ExternalLink, Globe, Loader2 } from 'lucide-react'
import { useLinkPreview } from '@/hooks/useLinkPreview'

interface LinkPreviewCardProps {
  /** The URL to display as a preview card */
  url: string
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
 * Skeleton loader for the card - vertical layout
 */
function CardSkeleton() {
  return (
    <span className="block my-3 rounded-xl border border-border bg-surface animate-pulse w-full max-w-lg overflow-hidden shadow-sm">
      {/* Header skeleton */}
      <span className="flex items-center gap-2 p-3 border-b border-border">
        <span className="w-5 h-5 bg-muted rounded" />
        <span className="flex-1 space-y-1">
          <span className="block h-4 bg-muted rounded w-1/3" />
          <span className="block h-3 bg-muted rounded w-2/3" />
        </span>
      </span>
      {/* Screenshot skeleton */}
      <span className="block h-[240px] bg-muted" />
    </span>
  )
}

/**
 * Simple link fallback component
 */
function SimpleLinkFallback({ url, children }: { url: string; children?: React.ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-primary hover:underline hover:!decoration-current text-sm break-all"
    >
      <Globe className="h-4 w-4 flex-shrink-0" />
      <span>{children || url}</span>
      <ExternalLink className="h-3 w-3 flex-shrink-0" />
    </a>
  )
}

/**
 * LinkPreviewCard component for rendering URLs as rich preview cards.
 *
 * Features:
 * - Vertical layout with header and large screenshot
 * - Header shows favicon, title, and domain
 * - Loading skeleton state
 * - Graceful fallback to simple link on error
 *
 * @param disabled - When true, skips metadata fetching and renders as simple link.
 */
export default function LinkPreviewCard({ url, disabled = false }: LinkPreviewCardProps) {
  // Only fetch preview when not disabled
  const { data, isLoading, error } = useLinkPreview(disabled ? '' : url)
  const domain = useMemo(() => getDomain(url), [url])

  // When disabled, render as simple link
  if (disabled) {
    return <SimpleLinkFallback url={url} />
  }

  // Loading state
  if (isLoading) {
    return <CardSkeleton />
  }

  // Error state or no data - fallback to simple link
  if (error || !data?.success) {
    return <SimpleLinkFallback url={url} />
  }

  // Website card - render vertical card with header and screenshot
  const hasScreenshot = !!data.image
  const displayTitle = data.title || domain

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block my-3 rounded-xl border border-border bg-surface hover:border-primary/50 hover:shadow-md hover:!no-underline transition-all overflow-hidden w-full max-w-lg group shadow-sm"
    >
      {/* Header section */}
      <span className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border bg-surface">
        {/* Favicon */}
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
          {data.favicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.favicon}
              alt=""
              className="w-5 h-5 rounded object-contain"
              onError={e => {
                const img = e.target as HTMLImageElement
                img.style.display = 'none'
                const parent = img.parentElement
                if (parent) {
                  parent.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-text-muted"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`
                }
              }}
            />
          ) : (
            <Globe className="w-[18px] h-[18px] text-text-muted" />
          )}
        </span>

        {/* Title and domain */}
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-text-primary truncate group-hover:text-primary transition-colors">
            {displayTitle}
          </span>
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <span className="truncate">{domain}</span>
            <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </span>
        </span>
      </span>

      {/* Screenshot area */}
      {hasScreenshot ? (
        <span className="block relative bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.image!}
            alt=""
            className="w-full h-auto max-h-[300px] object-cover object-top"
            onError={e => {
              const img = e.target as HTMLImageElement
              img.style.display = 'none'
            }}
          />
        </span>
      ) : (
        // No screenshot - show placeholder
        <span className="block h-[120px] bg-muted/50 flex items-center justify-center">
          <Globe className="w-10 h-10 text-text-muted/50" />
        </span>
      )}

      {/* Description section (if available) */}
      {data.description && (
        <span className="block px-3 py-2 border-t border-border">
          <span className="block text-xs text-text-muted line-clamp-2">{data.description}</span>
        </span>
      )}
    </a>
  )
}

/**
 * Inline loading indicator for streaming state
 */
export function LinkPreviewCardLoading() {
  return (
    <span className="inline-flex items-center gap-1.5 text-text-muted text-sm">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>Loading preview...</span>
    </span>
  )
}
