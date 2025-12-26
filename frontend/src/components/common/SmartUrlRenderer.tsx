// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import ImagePreview from '@/components/common/ImagePreview'
import LinkCard from '@/components/common/LinkCard'
import { isImageUrl } from '@/utils/url-detector'

interface SmartLinkProps {
  /** The URL to render */
  href: string
  /** Link text/children from Markdown */
  children: React.ReactNode
  /** Whether to use compact mode */
  compact?: boolean
}

/**
 * SmartLink component that renders URLs intelligently:
 * - Image URLs: Rendered as inline image previews with Lightbox
 * - Web URLs: Rendered as rich link cards with metadata
 */
export function SmartLink({ href, children, compact = false }: SmartLinkProps) {
  // Check if it's an image URL
  if (isImageUrl(href)) {
    // Extract alt text from children if it's a simple string
    const alt = typeof children === 'string' ? children : undefined
    return <ImagePreview src={href} alt={alt} />
  }

  // For web URLs, render as LinkCard
  const linkText = typeof children === 'string' ? children : undefined

  // If link text is the same as URL, use LinkCard
  // If link text is different (e.g., "[Click here](url)"), show both text and card
  if (!linkText || linkText === href) {
    return <LinkCard url={href} compact={compact} />
  }

  // For links with custom text, show the link text with a card below
  return (
    <span className="inline-block">
      <LinkCard url={href} linkText={linkText} compact={compact} />
    </span>
  )
}

interface SmartImageProps {
  /** The image source URL */
  src: string
  /** Alt text for the image */
  alt?: string
}

/**
 * SmartImage component for rendering Markdown images with preview and Lightbox.
 */
export function SmartImage({ src, alt }: SmartImageProps) {
  return <ImagePreview src={src} alt={alt} />
}

/**
 * Create custom Markdown components for MarkdownEditor.Markdown
 * that support smart URL rendering.
 */
export function createSmartMarkdownComponents(options?: {
  enableLinkCards?: boolean
  enableImagePreview?: boolean
  compact?: boolean
}) {
  const { enableLinkCards = true, enableImagePreview = true, compact = false } = options || {}

  return {
    // Custom link renderer
    a: ({
      href,
      children,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => {
      // If link cards are disabled or no href, render as normal link
      if (!enableLinkCards || !href) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        )
      }

      // Use SmartLink for intelligent rendering
      return <SmartLink href={href} compact={compact}>{children}</SmartLink>
    },

    // Custom image renderer
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      // If image preview is disabled or no src, render as normal img
      if (!enableImagePreview || !src) {
        return <img src={src} alt={alt} {...props} />
      }

      // Use SmartImage for preview with Lightbox
      return <SmartImage src={src} alt={alt} />
    },
  }
}
