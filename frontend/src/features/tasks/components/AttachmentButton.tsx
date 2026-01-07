// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useCallback } from 'react'
import { Paperclip } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SUPPORTED_EXTENSIONS, MAX_FILE_SIZE } from '@/apis/attachments'

import { useTranslation } from '@/hooks/useTranslation'

interface AttachmentButtonProps {
  /** Callback when files are selected */
  onFileSelect: (files: File | File[]) => void
  /** Whether the button is disabled */
  disabled?: boolean
}

/**
 * Attachment upload button component
 * Only responsible for showing the upload button and handling file selection
 * Uses ActionButton for consistent 36px size with other control buttons
 */
export default function AttachmentButton({
  onFileSelect,
  disabled = false,
}: AttachmentButtonProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [tooltipOpen, setTooltipOpen] = React.useState(false)

  const handleClick = useCallback(() => {
    if (!disabled) {
      // Close tooltip immediately when clicking
      setTooltipOpen(false)
      fileInputRef.current?.click()
    }
  }, [disabled])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
      // Reset input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [onFileSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (disabled) return

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
    },
    [disabled, onFileSelect]
  )

  // Build accept string for file input
  const acceptString = SUPPORTED_EXTENSIONS.join(',')

  // Tooltip content
  const tooltipContent = t('chat:upload.tooltip', {
    maxSize: MAX_FILE_SIZE / (1024 * 1024),
  })

  return (
    <div onDragOver={handleDragOver} onDrop={handleDrop}>
      {/* Hidden file input with multiple support */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptString}
        multiple
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled}
      />

      {/* Upload button */}
      <TooltipProvider delayDuration={300}>
        <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
          <TooltipTrigger asChild>
            <div>
              <ActionButton
                variant="outline"
                onClick={handleClick}
                disabled={disabled}
                icon={<Paperclip className="h-4 w-4" />}
                className="border-border bg-base text-text-primary hover:bg-hover"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs whitespace-pre-line">
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
