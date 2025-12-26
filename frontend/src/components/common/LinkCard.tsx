// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useCallback, useEffect, memo } from 'react';
import { ExternalLink, Globe, Loader2 } from 'lucide-react';
import { useUrlMetadata, type UrlMetadata } from '@/hooks/useUrlMetadata';

interface LinkCardProps {
  /** The URL to display */
  url: string;
  /** Optional link text (from markdown) */
  linkText?: string;
  /** Additional class names */
  className?: string;
}

/**
 * Extract domain from URL for display
 */
function getDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Link card component for rendering web page URLs with metadata preview
 * Shows title, description, and favicon fetched from the backend API
 * Falls back to a simple link if metadata fetch fails
 */
const LinkCard = memo(function LinkCard({ url, linkText, className = '' }: LinkCardProps) {
  const { metadata, loading, error } = useUrlMetadata(url);
  const domain = getDomain(url);

  const handleClick = useCallback(() => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [url]);

  // If loading, show skeleton
  if (loading) {
    return (
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border border-border bg-surface hover:bg-surface/80 transition-colors cursor-pointer ${className}`}
        onClick={handleClick}
      >
        <div className="flex-shrink-0 w-10 h-10 rounded-md bg-muted flex items-center justify-center">
          <Loader2 className="h-5 w-5 text-text-muted animate-spin" />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
          <div className="h-3 bg-muted rounded animate-pulse w-1/2" />
        </div>
      </div>
    );
  }

  // If error or no metadata, show simple link
  if (error || !metadata) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1.5 text-sm text-link hover:underline ${className}`}
      >
        <Globe className="h-4 w-4 text-text-muted flex-shrink-0" />
        <span className="truncate">{linkText || url}</span>
        <ExternalLink className="h-3 w-3 flex-shrink-0" />
      </a>
    );
  }

  // Render full card with metadata
  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border border-border bg-surface hover:bg-fill-tert hover:shadow-sm transition-all cursor-pointer group ${className}`}
      onClick={handleClick}
      role="link"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick();
        }
      }}
    >
      {/* Favicon */}
      <div className="flex-shrink-0 w-10 h-10 rounded-md bg-muted flex items-center justify-center overflow-hidden">
        {metadata.favicon ? (
          <img
            src={metadata.favicon}
            alt=""
            className="w-6 h-6 object-contain"
            onError={e => {
              // Hide image on error
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <Globe className="h-5 w-5 text-text-muted" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title */}
        <div className="flex items-center gap-1.5">
          <h4 className="text-sm font-medium text-text-primary truncate group-hover:text-primary transition-colors">
            {metadata.title || linkText || domain}
          </h4>
          <ExternalLink className="h-3 w-3 text-text-muted flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>

        {/* Description */}
        {metadata.description && (
          <p className="text-xs text-text-secondary line-clamp-2 mt-0.5">{metadata.description}</p>
        )}

        {/* Domain */}
        <p className="text-xs text-text-muted mt-1">{domain}</p>
      </div>
    </div>
  );
});

export default LinkCard;
