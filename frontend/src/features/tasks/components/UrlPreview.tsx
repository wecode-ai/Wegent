// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo } from 'react';
import {
  X,
  Globe,
  Image,
  FileText,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/ui/button';
import { getUrlDomain, formatFileSize, type UrlType } from '@/apis/url-parser';
import type { ParsedUrlState } from '../hooks/useUrlParser';

/**
 * Props for single URL preview item
 */
interface UrlPreviewItemProps {
  /** Parsed URL state */
  urlState: ParsedUrlState;
  /** Callback to remove URL */
  onRemove: (url: string) => void;
  /** Whether the item is disabled */
  disabled?: boolean;
  /** Whether to use compact mode (inline with attachments) */
  compact?: boolean;
}

/**
 * Get icon for URL type
 */
function getTypeIcon(type: UrlType) {
  switch (type) {
    case 'webpage':
      return <Globe className="h-4 w-4 text-blue-500" />;
    case 'image':
      return <Image className="h-4 w-4 text-green-500" aria-hidden="true" />;
    case 'pdf':
      return <FileText className="h-4 w-4 text-red-500" />;
    default:
      return <Globe className="h-4 w-4 text-text-muted" />;
  }
}

/**
 * Get type label
 */
function getTypeLabel(type: UrlType, t: (key: string) => string): string {
  switch (type) {
    case 'webpage':
      return t('urlPreview.typeWebpage');
    case 'image':
      return t('urlPreview.typeImage');
    case 'pdf':
      return t('urlPreview.typePdf');
    default:
      return t('urlPreview.typeUnknown');
  }
}

/**
 * Compact URL preview item component - matches FileUpload preview style
 */
function UrlPreviewItemCompact({ urlState, onRemove, disabled }: UrlPreviewItemProps) {
  const { t } = useTranslation('chat');
  const domain = useMemo(() => getUrlDomain(urlState.url), [urlState.url]);

  // Get display title - shorter for compact mode
  const displayTitle = urlState.title || domain || urlState.url;
  const truncatedTitle =
    displayTitle.length > 20 ? displayTitle.substring(0, 20) + '...' : displayTitle;

  // Get size display
  const sizeDisplay = urlState.size ? formatFileSize(urlState.size) : null;

  // Determine border/background based on status
  const containerClass = urlState.error
    ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
    : 'bg-muted border-border';

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${containerClass}`}>
      {/* Icon */}
      <span className="text-base flex-shrink-0">
        {urlState.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : urlState.error ? (
          <AlertCircle className="h-4 w-4 text-red-500" />
        ) : (
          getTypeIcon(urlState.type)
        )}
      </span>

      {/* Content - matches FileUpload AttachmentPreviewInline style */}
      <div className="flex flex-col min-w-0 max-w-[150px]">
        <span className="text-xs font-medium truncate" title={displayTitle}>
          {truncatedTitle}
        </span>
        <span className="text-xs text-text-muted">
          {domain}
          {sizeDisplay && ` · ${sizeDisplay}`}
        </span>
      </div>

      {/* Loading indicator for parsing */}
      {urlState.isLoading && <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />}

      {/* Remove button - matches FileUpload style */}
      {!disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onRemove(urlState.url)}
          className="h-5 w-5 ml-1 text-text-muted hover:text-text-primary"
          title={t('urlPreview.remove')}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

/**
 * Single URL preview item component - full mode
 */
function UrlPreviewItem({ urlState, onRemove, disabled, compact }: UrlPreviewItemProps) {
  const { t } = useTranslation('chat');
  const domain = useMemo(() => getUrlDomain(urlState.url), [urlState.url]);

  // Use compact mode if specified
  if (compact) {
    return <UrlPreviewItemCompact urlState={urlState} onRemove={onRemove} disabled={disabled} />;
  }

  // Get display title
  const displayTitle = urlState.title || domain || urlState.url;

  // Get size display
  const sizeDisplay = urlState.size ? formatFileSize(urlState.size) : null;

  // Truncate title if too long
  const truncatedTitle =
    displayTitle.length > 50 ? displayTitle.substring(0, 50) + '...' : displayTitle;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 bg-muted rounded-lg border border-border ${urlState.error ? 'border-red-300 bg-red-50/50 dark:bg-red-900/10' : ''}`}
    >
      {/* Icon */}
      <div className="flex-shrink-0">
        {urlState.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : urlState.error ? (
          <AlertCircle className="h-4 w-4 text-red-500" />
        ) : (
          getTypeIcon(urlState.type)
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate" title={displayTitle}>
            {truncatedTitle}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>{domain}</span>
          {!urlState.isLoading && !urlState.error && (
            <>
              <span>•</span>
              <span>{getTypeLabel(urlState.type, t)}</span>
              {sizeDisplay && (
                <>
                  <span>•</span>
                  <span>{sizeDisplay}</span>
                </>
              )}
              {urlState.truncated && (
                <>
                  <span>•</span>
                  <span className="text-orange-500">{t('urlPreview.truncated')}</span>
                </>
              )}
            </>
          )}
          {urlState.error && (
            <span className="text-red-500 truncate" title={urlState.error}>
              {urlState.error}
            </span>
          )}
        </div>
      </div>

      {/* Remove button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 flex-shrink-0"
        onClick={() => onRemove(urlState.url)}
        disabled={disabled}
        title={t('urlPreview.remove')}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * Props for UrlPreview component
 */
interface UrlPreviewProps {
  /** Array of parsed URL states */
  parsedUrls: ParsedUrlState[];
  /** Callback to remove a URL */
  onRemove: (url: string) => void;
  /** Whether the preview is disabled */
  disabled?: boolean;
  /** Whether the preview is collapsed */
  defaultCollapsed?: boolean;
  /** Whether to use compact mode (inline with attachments) */
  compact?: boolean;
}

/**
 * URL Preview component for displaying parsed URLs above chat input.
 *
 * Shows parsed URLs with their type, title, and content summary.
 * Supports collapsing to save space.
 * In compact mode, renders inline items without header (for attachment area).
 */
export default function UrlPreview({
  parsedUrls,
  onRemove,
  disabled = false,
  defaultCollapsed = false,
  compact = false,
}: UrlPreviewProps) {
  const { t } = useTranslation('chat');
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  // Don't render if no URLs
  if (parsedUrls.length === 0) {
    return null;
  }

  // Compact mode: render inline items without header (for attachment area)
  if (compact) {
    return (
      <>
        {parsedUrls.map(urlState => (
          <UrlPreviewItemCompact
            key={urlState.url}
            urlState={urlState}
            onRemove={onRemove}
            disabled={disabled}
          />
        ))}
      </>
    );
  }

  // Full mode: render with header and collapse functionality
  // Count successfully parsed URLs
  const successCount = parsedUrls.filter(u => !u.isLoading && !u.error && u.content).length;
  const loadingCount = parsedUrls.filter(u => u.isLoading).length;
  const errorCount = parsedUrls.filter(u => u.error).length;

  return (
    <div className="w-full mb-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-secondary">
            📎 {t('urlPreview.title')}
          </span>
          {loadingCount > 0 && (
            <span className="text-xs text-text-muted">
              ({loadingCount} {t('urlPreview.loading')})
            </span>
          )}
          {successCount > 0 && loadingCount === 0 && (
            <span className="text-xs text-text-muted">
              ({successCount} {t('urlPreview.parsed')})
            </span>
          )}
          {errorCount > 0 && (
            <span className="text-xs text-red-500">
              ({errorCount} {t('urlPreview.failed')})
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-text-muted"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? (
            <>
              {t('urlPreview.expand')} <ChevronDown className="h-3 w-3 ml-1" />
            </>
          ) : (
            <>
              {t('urlPreview.collapse')} <ChevronUp className="h-3 w-3 ml-1" />
            </>
          )}
        </Button>
      </div>

      {/* URL List */}
      {!isCollapsed && (
        <div className="space-y-1.5">
          {parsedUrls.map(urlState => (
            <UrlPreviewItem
              key={urlState.url}
              urlState={urlState}
              onRemove={onRemove}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
