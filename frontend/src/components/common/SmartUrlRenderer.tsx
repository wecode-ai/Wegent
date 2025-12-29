// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import ImagePreview from '@/components/common/ImagePreview';
import LinkCard from '@/components/common/LinkCard';
import { isImageUrl, detectUrls } from '@/utils/url-detector';

/**
 * Check if a URL is an absolute HTTP(S) URL.
 * Returns false for relative URLs, anchors, and non-HTTP protocols.
 *
 * @param url - The URL string to check
 * @returns true if the URL is an absolute HTTP or HTTPS URL
 */
function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    // URL construction fails for relative URLs or invalid URLs
    return false;
  }
}

interface SmartLinkProps {
  /** The URL to render */
  href: string;
  /** Link text/children from Markdown */
  children: React.ReactNode;
  /** Whether to use compact mode */
  compact?: boolean;
  /**
   * Whether to disable rich rendering (metadata fetching).
   * When true, renders URLs as simple clickable links.
   * Useful during streaming to avoid excessive API calls.
   */
  disabled?: boolean;
}

/**
 * SmartLink component that renders URLs intelligently:
 * - Relative URLs, anchors, and non-HTTP protocols: Rendered as plain links
 * - Image URLs: Rendered as inline image previews with Lightbox
 * - Web URLs: Rendered as original link text + rich link card below
 *
 * @param disabled - When true, skips metadata fetching and renders as simple link.
 *                   Use this during streaming to avoid excessive API calls.
 */
export function SmartLink({ href, children, compact = false, disabled = false }: SmartLinkProps) {
  // For non-absolute HTTP(S) URLs (relative links, anchors, mailto:, tel:, etc.),
  // render as a plain link to avoid incorrect card rendering
  if (!isAbsoluteHttpUrl(href)) {
    return (
      <a href={href} className="text-primary hover:underline">
        {children}
      </a>
    );
  }

  // Check if it's an image URL
  if (isImageUrl(href)) {
    // Extract alt text from children if it's a simple string
    const alt = typeof children === 'string' ? children : undefined;
    return <ImagePreview src={href} alt={alt} />;
  }

  // For web URLs, render original markdown link + LinkCard below
  const linkText = typeof children === 'string' ? children : undefined;
  const hasCustomText = linkText && linkText !== href;

  // Always show original link text first, then card below
  return (
    <span className="block w-full max-w-full">
      {/* Original markdown link */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
      >
        {hasCustomText ? linkText : href}
      </a>
      {/* Link card below */}
      <LinkCard url={href} compact={compact} disabled={disabled} />
    </span>
  );
}

interface SmartImageProps {
  /** The image source URL */
  src: string;
  /** Alt text for the image */
  alt?: string;
}

/**
 * SmartImage component for rendering Markdown images with preview and Lightbox.
 */
export function SmartImage({ src, alt }: SmartImageProps) {
  return <ImagePreview src={src} alt={alt} />;
}

/**
 * Create custom Markdown components for MarkdownEditor.Markdown
 * that support smart URL rendering.
 *
 * @param options.disabled - When true, skips metadata fetching for link cards.
 *                           Use this during streaming to avoid excessive API calls.
 */
export function createSmartMarkdownComponents(options?: {
  enableLinkCards?: boolean;
  enableImagePreview?: boolean;
  compact?: boolean;
  /** When true, disables rich rendering (metadata fetching) for links */
  disabled?: boolean;
}) {
  const {
    enableLinkCards = true,
    enableImagePreview = true,
    compact = false,
    disabled = false,
  } = options || {};

  return {
    // Custom link renderer
    a: ({
      href,
      children,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => {
      // If no href, render as normal element
      if (!href) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      }

      // For non-absolute HTTP(S) URLs, render as plain link
      // This handles anchors (#section), relative paths (./path, ../path, /path),
      // and non-HTTP protocols (mailto:, tel:, etc.)
      if (!isAbsoluteHttpUrl(href)) {
        return (
          <a href={href} className="text-primary hover:underline" {...props}>
            {children}
          </a>
        );
      }

      // If link cards are disabled, render as normal external link
      if (!enableLinkCards) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        );
      }

      // Use SmartLink for intelligent rendering of absolute HTTP(S) URLs
      return (
        <SmartLink href={href} compact={compact} disabled={disabled}>
          {children}
        </SmartLink>
      );
    },

    // Custom image renderer
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      // If image preview is disabled or no src or src is not a string, render as normal img
      if (!enableImagePreview || !src || typeof src !== 'string') {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={src} alt={alt} {...props} />;
      }

      // Use SmartImage for preview with Lightbox
      return <SmartImage src={src} alt={alt} />;
    },
  };
}

interface SmartTextLineProps {
  /** The text line to render */
  text: string;
  /** CSS class name for the container */
  className?: string;
  /**
   * Whether to disable rich rendering (metadata fetching).
   * When true, renders URLs as simple clickable links.
   * Useful during streaming to avoid excessive API calls.
   */
  disabled?: boolean;
}

/**
 * SmartTextLine component for rendering a single line of plain text
 * with intelligent URL detection and rendering.
 *
 * Detects URLs in the text and renders them appropriately:
 * - Image URLs: Rendered as inline image previews
 * - Web URLs: Rendered as rich link cards (unless disabled)
 * - Other text: Rendered as plain text
 *
 * @param disabled - When true, skips metadata fetching and renders URLs as simple links.
 *                   Use this during streaming to avoid excessive API calls.
 */
export function SmartTextLine({ text, className = '', disabled = false }: SmartTextLineProps) {
  // If empty line, return non-breaking space to preserve line height
  if (!text) {
    return <div className={`text-sm break-all min-h-[1.25em] ${className}`}>{'\u00A0'}</div>;
  }

  // Detect URLs in the text
  const detectedUrls = detectUrls(text);

  // If no URLs found, render as plain text
  if (detectedUrls.length === 0) {
    return <div className={`text-sm break-all min-h-[1.25em] ${className}`}>{text}</div>;
  }

  // Build segments: alternating between plain text and URL components
  const segments: React.ReactNode[] = [];
  let lastIndex = 0;

  detectedUrls.forEach((urlInfo, index) => {
    // Add text before this URL
    if (urlInfo.startIndex > lastIndex) {
      const textBefore = text.slice(lastIndex, urlInfo.startIndex);
      if (textBefore) {
        segments.push(<span key={`text-${index}`}>{textBefore}</span>);
      }
    }

    // Add the URL component
    if (urlInfo.isImage) {
      segments.push(
        <ImagePreview
          key={`url-${index}`}
          src={urlInfo.url}
          alt={urlInfo.altText || urlInfo.linkText}
        />
      );
    } else {
      segments.push(
        <LinkCard
          key={`url-${index}`}
          url={urlInfo.url}
          linkText={urlInfo.linkText}
          compact={false}
          disabled={disabled}
        />
      );
    }

    lastIndex = urlInfo.endIndex;
  });

  // Add any remaining text after the last URL
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex);
    if (textAfter) {
      segments.push(<span key="text-end">{textAfter}</span>);
    }
  }

  return <div className={`text-sm break-all min-h-[1.25em] ${className}`}>{segments}</div>;
}
