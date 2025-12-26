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
  /** Children content (link text) */
  children?: React.ReactNode
  /** Optional CSS class name */
  className?: string
}

/**
 * Smart link component that automatically renders URLs as either:
 * - Image preview (for image URLs)
 * - Link card (for webpage URLs)
 *
 * Used by the markdown renderer in MessageBubble to enhance link rendering
 */
export default function SmartLink({ href, children, className }: SmartLinkProps) {
  // Extract text content from children for display
  const displayText = React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string') return child
      if (typeof child === 'number') return String(child)
      return ''
    })
    .join('')

  // Check if URL is an image
  if (isImageUrl(href)) {
    return (
      <span className={className}>
        <ImagePreview
          src={href}
          alt={displayText || href}
          maxWidth={300}
          maxHeight={200}
        />
      </span>
    )
  }

  // Render as link card for non-image URLs
  return (
    <span className={className}>
      <LinkCard url={href} displayText={displayText !== href ? displayText : undefined} />
    </span>
  )
}
