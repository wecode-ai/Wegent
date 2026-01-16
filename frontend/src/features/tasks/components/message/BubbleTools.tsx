// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Copy, Check, ThumbsUp, ThumbsDown, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from 'react-i18next'
import type { FeedbackState } from '@/hooks/useMessageFeedback'

// CopyButton component for copying markdown content
export const CopyButton = ({
  content,
  className,
  tooltip,
  onCopySuccess,
}: {
  content: string
  className?: string
  tooltip?: string
  /** Optional callback when copy succeeds - used for telemetry */
  onCopySuccess?: () => void
}) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(content)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        onCopySuccess?.()
        return
      } catch (err) {
        console.error('Failed to copy text: ', err)
      }
    }

    try {
      const textarea = document.createElement('textarea')
      textarea.value = content
      textarea.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      onCopySuccess?.()
    } catch (err) {
      console.error('Fallback copy failed: ', err)
    }
  }

  const button = (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className={className ?? 'h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-text-muted" />
      )}
    </Button>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{copied ? 'Copied!' : tooltip}</TooltipContent>
      </Tooltip>
    )
  }

  return button
}

// EditButton component for editing user messages
export const EditButton = ({
  onEdit,
  className,
  tooltip,
  disabled,
}: {
  onEdit: () => void
  className?: string
  tooltip?: string
  disabled?: boolean
}) => {
  const button = (
    <Button
      variant="ghost"
      size="icon"
      onClick={onEdit}
      disabled={disabled}
      className={
        className ??
        'h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec disabled:opacity-50'
      }
    >
      <Pencil className="h-3.5 w-3.5 text-text-muted" />
    </Button>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }

  return button
}

export interface BubbleToolsProps {
  contentToCopy: string
  tools?: Array<{
    key: string
    title: string
    icon: React.ReactNode
    onClick: () => void
  }>
  /** Optional callback when copy succeeds - used for telemetry */
  onCopySuccess?: () => void
  /** Current feedback state (from useMessageFeedback hook) */
  feedback: FeedbackState
  /** Handler for like button click (from useMessageFeedback hook) */
  onLike: () => void
  /** Handler for dislike button click (from useMessageFeedback hook) */
  onDislike: () => void
  /** Labels for feedback buttons */
  feedbackLabels?: {
    like: string
    dislike: string
  }
}

// Bubble toolbar: supports copy button, feedback buttons, and extensible tool buttons
const BubbleTools = ({
  contentToCopy,
  tools = [],
  onCopySuccess,
  feedback,
  onLike,
  onDislike,
  feedbackLabels,
}: BubbleToolsProps) => {
  const { t } = useTranslation()

  return (
    <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
      {/* Copy button */}
      <CopyButton
        content={contentToCopy}
        onCopySuccess={onCopySuccess}
        tooltip={t('chat:actions.copy') || 'Copy'}
        className="h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec"
      />
      {/* Feedback buttons: like and dislike */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onLike}
            className={`h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec ${feedback === 'like' ? 'text-green-500' : ''}`}
          >
            <ThumbsUp
              className={`h-3.5 w-3.5 ${feedback === 'like' ? 'fill-current' : 'text-text-muted'}`}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{feedbackLabels?.like || 'Like'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDislike}
            className={`h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec ${feedback === 'dislike' ? 'text-red-500' : ''}`}
          >
            <ThumbsDown
              className={`h-3.5 w-3.5 ${feedback === 'dislike' ? 'fill-current' : 'text-text-muted'}`}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{feedbackLabels?.dislike || 'Dislike'}</TooltipContent>
      </Tooltip>
      {/* Additional tool buttons (e.g., download) */}
      {tools.map(tool => (
        <Tooltip key={tool.key}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={tool.onClick}
              className="h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec"
            >
              {tool.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tool.title}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

export default BubbleTools
