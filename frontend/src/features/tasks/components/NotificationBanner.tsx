// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ArrowTopRightOnSquareIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type NotificationBannerVariant = 'warning' | 'info'

interface NotificationBannerProps {
  className?: string
  storageKey: string
  title: string
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
  badgeText,
  actionLabel,
  actionHref,
  reopenLabel,
  variant = 'info',
}: NotificationBannerProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [isReady, setIsReady] = useState(false)

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
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium leading-6 text-text-primary">{title}</span>
              {badgeText && (
                <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold text-text-primary dark:bg-white/10">
                  {badgeText}
                </span>
              )}
            </div>
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
