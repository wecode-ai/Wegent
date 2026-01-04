// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas Panel - Right side panel for code/document editing
 */

'use client'

import React from 'react'
import { X, FileCode, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface CanvasPanelProps {
  content: string
  fileType: string
  title: string
  onContentChange: (content: string, fileType?: string, title?: string) => void
  onClose: () => void
  taskId: number
}

export function CanvasPanel({
  content,
  fileType,
  title,
  onContentChange,
  onClose,
}: CanvasPanelProps) {
  const { t } = useTranslation('canvas')

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onContentChange(e.target.value)
  }

  const isCodeFile =
    fileType.includes('code') ||
    ['python', 'javascript', 'typescript', 'java', 'go', 'rust'].includes(
      fileType
    )

  return (
    <div className="h-full flex flex-col bg-surface border-l border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {isCodeFile ? (
            <FileCode className="h-4 w-4 text-text-muted" />
          ) : (
            <FileText className="h-4 w-4 text-text-muted" />
          )}
          <span className="font-medium text-text-primary">{title}</span>
          <span className="text-xs text-text-muted px-2 py-0.5 bg-muted rounded">
            {fileType}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Editor Area */}
      <div className="flex-1 overflow-hidden">
        <textarea
          value={content}
          onChange={handleContentChange}
          className="w-full h-full p-4 bg-base text-text-primary font-mono text-sm resize-none focus:outline-none"
          placeholder={t('placeholder', 'Start writing...')}
          spellCheck={false}
        />
      </div>
    </div>
  )
}
