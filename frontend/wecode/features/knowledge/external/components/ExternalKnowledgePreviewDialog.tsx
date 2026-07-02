// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExternalKnowledgePreview } from '@wecode/types/external-knowledge'
import { ApReadonlyBadge } from './ExternalKnowledgeShared'

interface ExternalKnowledgePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: ExternalKnowledgePreview | null
  title: string
  testId: string
  iframeTestId: string
}

export function ExternalKnowledgePreviewDialog({
  open,
  onOpenChange,
  preview,
  title,
  testId,
  iframeTestId,
}: ExternalKnowledgePreviewDialogProps) {
  const { t } = useTranslation('knowledge')

  const openInNewTab = () => {
    if (!preview?.url) return

    const anchor = document.createElement('a')
    anchor.href = preview.url
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.click()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100dvh-16px)] max-h-[calc(100dvh-16px)] w-[calc(100vw-16px)] max-w-[calc(100vw-16px)] flex-col gap-0 p-0 sm:h-[85vh] sm:max-h-[85vh] sm:max-w-4xl"
        data-testid={testId}
      >
        <DialogHeader className="flex-shrink-0 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center justify-between gap-3 pr-8">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle className="truncate text-base font-medium text-text-primary">
                {title}
              </DialogTitle>
              <ApReadonlyBadge />
            </div>
            {preview?.url ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-[44px] shrink-0 px-3 sm:h-9"
                onClick={openInNewTab}
                data-testid={`${testId}-open-new-tab-button`}
              >
                <ExternalLink className="h-4 w-4" />
                {t('external.preview.openInNewTab')}
              </Button>
            ) : null}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {preview ? (
            <iframe
              src={preview.url}
              title={title}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-forms allow-popups"
              referrerPolicy="no-referrer"
              data-testid={iframeTestId}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
