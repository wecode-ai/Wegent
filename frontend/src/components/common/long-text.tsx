// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface LongTextTooltipProps {
  content?: string | null
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>
  side?: React.ComponentProps<typeof TooltipContent>['side']
  align?: React.ComponentProps<typeof TooltipContent>['align']
  contentClassName?: string
  ariaLabel?: string
}

export function LongTextTooltip({
  content,
  children,
  side = 'top',
  align = 'start',
  contentClassName,
  ariaLabel,
}: LongTextTooltipProps) {
  if (!content) return children

  const trigger = React.cloneElement(children, {
    title: undefined,
    'aria-label': children.props['aria-label'] ?? ariaLabel ?? content,
  } as Partial<React.HTMLAttributes<HTMLElement>>)

  if (process.env.NODE_ENV === 'test') return trigger

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          className={cn(
            'max-w-[min(28rem,calc(100vw-2rem))] whitespace-pre-wrap break-words',
            contentClassName
          )}
        >
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface TruncatedTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string
  tooltipText?: string
  focusable?: boolean
  tooltip?: boolean
  nativeTitle?: boolean
}

export function TruncatedText({
  text,
  tooltipText,
  focusable = true,
  tooltip,
  nativeTitle = false,
  className,
  ...props
}: TruncatedTextProps) {
  const fullText = tooltipText ?? text
  const shouldRenderTooltip = nativeTitle ? false : (tooltip ?? focusable)
  const label = (
    <span
      {...props}
      className={cn('block min-w-0 truncate', className)}
      title={nativeTitle ? fullText : undefined}
      aria-label={fullText}
      tabIndex={focusable ? 0 : undefined}
    >
      {text}
    </span>
  )

  if (!shouldRenderTooltip) return label

  return <LongTextTooltip content={fullText}>{label}</LongTextTooltip>
}
