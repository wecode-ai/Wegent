// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfmSafe from '@/lib/remark-gfm-safe'
import type { Components } from 'react-markdown'

interface SubmitHintMarkdownProps {
  /** Markdown content to render */
  content: string
  /** Additional CSS class names */
  className?: string
}

// URL transform that allows dingtalk:// protocol
function createSubmitHintUrlTransform(): (url: string) => string {
  const allowedProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:', 'dingtalk:'])

  return (url: string): string => {
    const trimmed = url.trim()
    const protocolMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(trimmed)
    if (!protocolMatch) {
      return trimmed
    }
    const protocol = protocolMatch[0].toLowerCase()
    if (allowedProtocols.has(protocol)) {
      return trimmed
    }
    return ''
  }
}

// Simple link component that allows non-HTTP URLs
const LinkComponent: Components['a'] = ({ href, children, ...props }) => {
  if (!href) {
    return <a {...props}>{children}</a>
  }

  // Filter out react-markdown internal props
  const { node: _node, ...validProps } = props as React.AnchorHTMLAttributes<HTMLAnchorElement> &
    Record<string, unknown>

  // For non-HTTP(S) URLs (dingtalk, mailto, tel, etc.), render without target="_blank"
  const isHttp = href.startsWith('http://') || href.startsWith('https://')

  return (
    <a
      href={href}
      className="text-primary hover:underline"
      {...(isHttp && { target: '_blank', rel: 'noopener noreferrer' })}
      {...validProps}
    >
      {children}
    </a>
  )
}

const components: Components = {
  a: LinkComponent,
  p: ({ children }) => <p className="m-0">{children}</p>,
}

/**
 * SubmitHintMarkdown - Simplified Markdown renderer for submit hints
 *
 * Features:
 * - Supports dingtalk:// protocol for DingTalk app links
 * - Basic Markdown (bold, italic, links)
 * - No code highlighting or advanced features
 */
export const SubmitHintMarkdown = memo(function SubmitHintMarkdown({
  content,
  className = '',
}: SubmitHintMarkdownProps) {
  const urlTransform = useMemo(() => createSubmitHintUrlTransform(), [])

  if (!content?.trim()) return null

  return (
    <div className={`submit-hint-markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfmSafe]}
        components={components}
        urlTransform={urlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

export default SubmitHintMarkdown
