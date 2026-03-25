// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ArrowTopRightOnSquareIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

type NotificationBannerVariant = 'warning' | 'info'

/**
 * Parse text with Markdown-style links [text](url) and return React elements.
 * Supports both internal links (starting with /) and external links.
 * @deprecated Use `content` prop with EnhancedMarkdown instead
 */
function parseTextWithLinks(text: string): React.ReactNode {
  // Regex to match Markdown-style links: [text](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(text)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    const linkText = match[1]
    const linkUrl = match[2]
    const isExternal = linkUrl.startsWith('http://') || linkUrl.startsWith('https://')

    // Add the link element
    parts.push(
      <a
        key={`link-${match.index}`}
        href={linkUrl}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noopener noreferrer' : undefined}
        className="text-primary hover:text-primary/80 underline underline-offset-2 transition-colors"
      >
        {linkText}
      </a>
    )

    lastIndex = match.index + match[0].length
  }

  // Add remaining text after the last link
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  // If no links found, return original text
  if (parts.length === 0) {
    return text
  }

  return <>{parts}</>
}

interface NotificationBannerProps {
  className?: string
  storageKey: string
  title?: string
  /** @deprecated Use `content` prop instead for full Markdown support */
  items?: string[]
  /** Markdown content to render directly */
  content?: string
  badgeText?: string
  actionLabel?: string
  actionHref?: string
  reopenLabel: string
  variant?: NotificationBannerVariant
}

const variantStyles: Record<NotificationBannerVariant, string> = {
  warning: `
    bg-gradient-to-r from-orange-50 to-red-50
    dark:from-orange-950/30 dark:to-red-950/30
    border-orange-200 dark:border-orange-800
  `,
  info: `
    bg-gradient-to-r from-sky-50 to-teal-50
    dark:from-sky-950/30 dark:to-teal-950/30
    border-sky-200 dark:border-sky-800
  `,
}

export default function NotificationBanner({
  className,
  storageKey,
  title,
  items,
  content,
  badgeText,
  actionLabel,
  actionHref,
  reopenLabel,
  variant = 'info',
}: NotificationBannerProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [isReady, setIsReady] = useState(false)
  const { theme } = useTheme()

  useEffect(() => {
    const isClosed = localStorage.getItem(storageKey) === 'true'
    setIsVisible(!isClosed)
    setIsReady(true)
  }, [storageKey])

  const handleClose = () => {
    setIsVisible(false)
    localStorage.setItem(storageKey, 'true')
  }

  const handleReopen = () => {
    setIsVisible(true)
    localStorage.removeItem(storageKey)
  }

  if (!isReady) {
    return null
  }

  if (!isVisible) {
    return (
      <div className={cn('w-full', className)}>
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-text-secondary hover:text-text-primary"
            onClick={handleReopen}
          >
            {reopenLabel}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('w-full', className)}>
      <Card
        className={cn(
          'relative border p-3 shadow-sm transition-all duration-300 hover:shadow-md sm:p-4',
          variantStyles[variant]
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1.5 top-1.5 z-10 h-6 w-6 text-text-secondary hover:text-text-primary sm:right-2 sm:top-2"
          onClick={handleClose}
          aria-label="Close notification"
        >
          <XMarkIcon className="h-4 w-4" />
        </Button>
        <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            {title && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium leading-5 text-text-primary">{title}</span>
                {badgeText && (
                  <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold text-text-primary dark:bg-white/10">
                    {badgeText}
                  </span>
                )}
              </div>
            )}
            {/* New: Render Markdown content directly */}
            {content && (
              <div
                className={cn(
                  'notification-markdown-container',
                  'text-sm pb-0 leading-5 text-text-primary prose prose-sm max-w-none dark:prose-invert',
                  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:transition-colors hover:[&_a]:text-primary/80',
                  '[&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-0.5 [&_ul]:my-0 [&_ul]:mb-0',
                  '[&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-0.5 [&_ol]:my-0 [&_ol]:mb-0',
                  '[&_p]:my-0 [&_p]:mb-0',
                  '[&_li]:my-0 [&_li]:mb-0',
                  '[&_.wmde-markdown]:mb-0 [&_.markdown-content]:mb-0',
                  '[&>div]:mb-0 [&>div>div]:mb-0',
                  title && 'mt-1'
                )}
                style={
                  {
                    '--color-canvas-default': 'transparent',
                    '--color-canvas-subtle': 'transparent',
                  } as React.CSSProperties
                }
              >
                <div
                  className="[&_.wmde-markdown]:!bg-transparent [&_.markdown-content]:!bg-transparent [&>*]:!bg-transparent"
                  style={{ background: 'transparent' }}
                >
                  <EnhancedMarkdown source={content} theme={theme} />
                </div>
              </div>
            )}
            {/* Legacy: Render items array (deprecated) */}
            {!content && items && items.length > 0 && (
              <ul className={cn('space-y-0.5', title && 'mt-1')}>
                {items.map((item, index) => (
                  <li
                    key={index}
                    className="flex items-baseline gap-2 text-sm leading-5 text-text-primary"
                  >
                    <span className="h-1 w-1 shrink-0 rounded-full bg-primary/70" />
                    <span>{parseTextWithLinks(item)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {actionLabel && actionHref && (
            <Button
              asChild
              variant="primary"
              size="sm"
              className="h-9 w-full rounded-full px-4 sm:w-auto sm:shrink-0"
            >
              <a href={actionHref} target="_blank" rel="noopener noreferrer">
                {actionLabel}
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              </a>
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
