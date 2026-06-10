// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState } from 'react'
import { Globe2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ActionButton } from '@/components/ui/action-button'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { webContentApi } from '@/apis/web-content'
import { ApiError } from '@/apis/client'
import type { Attachment } from '@/types/api'

interface ExternalWebContentButtonProps {
  attachments: Attachment[]
  onAttachmentAdd: (attachment: Attachment) => void
  disabled?: boolean
  triggerVariant?: 'icon' | 'menu-item'
}

function getExternalWebContentErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'externalWebContent.errors.crawlFailed'
  }

  if (error.status === 502) {
    if (error.message.includes('download')) {
      return 'externalWebContent.errors.videoDownloadFailed'
    }
    if (error.message.includes('upload') || error.message.includes('fid')) {
      return 'externalWebContent.errors.videoUploadFailed'
    }
    return 'externalWebContent.errors.serviceUnavailable'
  }

  if (error.status === 422) {
    if (error.message.includes('No video_url_s3')) {
      return 'externalWebContent.errors.noVideo'
    }
    if (error.message.includes('absolute HTTP')) {
      return 'externalWebContent.errors.invalidUrl'
    }
    if (error.message.includes('more than')) {
      return 'externalWebContent.errors.tooManyVideos'
    }
    if (error.message.includes('file size')) {
      return 'externalWebContent.errors.videoTooLarge'
    }
  }

  return 'externalWebContent.errors.crawlFailed'
}

export default function ExternalWebContentButton({
  attachments,
  onAttachmentAdd,
  disabled = false,
  triggerVariant = 'icon',
}: ExternalWebContentButtonProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [isCrawling, setIsCrawling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedSourceUrls = useMemo(
    () =>
      new Set(
        attachments
          .map(attachment => attachment.source_url)
          .filter((sourceUrl): sourceUrl is string => Boolean(sourceUrl))
      ),
    [attachments]
  )

  const resetDialog = () => {
    setUrl('')
    setError(null)
    setIsCrawling(false)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (isCrawling) return
    setOpen(nextOpen)
    if (!nextOpen) {
      resetDialog()
    }
  }

  const handleCrawl = async () => {
    const trimmedUrl = url.trim()
    setError(null)

    if (!trimmedUrl) {
      setError(t('externalWebContent.errors.urlRequired'))
      return
    }

    if (selectedSourceUrls.has(trimmedUrl)) {
      setError(t('externalWebContent.errors.duplicate'))
      return
    }

    setIsCrawling(true)
    try {
      const response = await webContentApi.crawl(trimmedUrl)
      for (const attachment of response.attachments) {
        onAttachmentAdd({
          id: attachment.id,
          filename: attachment.filename,
          file_size: attachment.file_size,
          mime_type: attachment.mime_type,
          status: attachment.status,
          text_length: attachment.text_length,
          error_message: attachment.error_message,
          error_code: attachment.error_code,
          subtask_id: null,
          file_extension: attachment.file_extension || '.mp4',
          created_at: attachment.created_at || new Date().toISOString(),
          truncation_info: attachment.truncation_info,
          video_count: attachment.video_count,
          site: attachment.site,
          source_url: attachment.source_url,
          cover_url: attachment.cover_url,
        })
      }
      toast({
        title: t('externalWebContent.added'),
        description: t('externalWebContent.videoCount', {
          count: response.attachments.length,
        }),
      })
      setOpen(false)
      resetDialog()
    } catch (err) {
      setError(t(getExternalWebContentErrorKey(err)))
    } finally {
      setIsCrawling(false)
    }
  }

  const openDialog = () => {
    setOpen(true)
  }

  const trigger =
    triggerVariant === 'menu-item' ? (
      <Button
        type="button"
        variant="ghost"
        data-testid="external-web-content-menu-button"
        onClick={openDialog}
        disabled={disabled}
        className="flex h-11 w-full items-center justify-start gap-3 px-3 text-sm"
      >
        <Globe2 className="h-4 w-4 text-text-muted" />
        <span>{t('externalWebContent.trigger')}</span>
      </Button>
    ) : (
      <ActionButton
        onClick={openDialog}
        disabled={disabled}
        title={t('externalWebContent.trigger')}
        data-testid="external-web-content-button"
        icon={<Globe2 className="h-4 w-4" />}
      />
    )

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('externalWebContent.title')}</DialogTitle>
            <DialogDescription>{t('externalWebContent.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <Input
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder={t('externalWebContent.placeholder')}
              disabled={isCrawling}
              data-testid="external-web-content-url-input"
            />
            {isCrawling && (
              <div className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-muted">
                {t('externalWebContent.crawlingHint')}
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isCrawling}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleCrawl}
              disabled={isCrawling}
              data-testid="external-web-content-crawl-button"
            >
              {isCrawling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('externalWebContent.crawl')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
