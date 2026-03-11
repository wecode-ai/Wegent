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
  /** Override the accepted file types (e.g. image-only for generation modes) */
  accept?: string
}

/**
 * Attachment upload button component
 * Only responsible for showing the upload button and handling file selection
 * Uses ActionButton for consistent 36px size with other control buttons
 */
export default function AttachmentButton({
  onFileSelect,
  disabled = false,
  accept,
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

  // Build accept string for file input - use override if provided
  const acceptString = accept ?? SUPPORTED_EXTENSIONS.join(',')

  // Check if a file matches the accept criteria
  const isFileAccepted = useCallback(
    (file: File) => {
      if (!accept) return true

      return accept.split(',').some(rule => {
        const token = rule.trim().toLowerCase()
        if (!token) return false

        if (token.endsWith('/*')) {
          return file.type.toLowerCase().startsWith(token.slice(0, -1))
        }

        if (token.startsWith('.')) {
          return file.name.toLowerCase().endsWith(token)
        }

        return file.type.toLowerCase() === token
      })
    },
    [accept]
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        const acceptedFiles = Array.from(files).filter(isFileAccepted)
        if (acceptedFiles.length > 0) {
          onFileSelect(acceptedFiles)
        }
      }
      // Reset input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [isFileAccepted, onFileSelect]
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
        const acceptedFiles = Array.from(files).filter(isFileAccepted)
        if (acceptedFiles.length > 0) {
          onFileSelect(acceptedFiles)
        }
      }
    },
    [disabled, isFileAccepted, onFileSelect]
  )

  // Tooltip content - use image-specific tooltip when accept is image/*
  const isImageOnly = accept === 'image/*'
  const tooltipContent = isImageOnly
    ? t('chat:upload.image_tooltip', {
        maxSize: MAX_FILE_SIZE / (1024 * 1024),
      })
    : t('chat:upload.tooltip', {
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
                onClick={handleClick}
                disabled={disabled}
                icon={<Paperclip className="h-4 w-4" />}
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
