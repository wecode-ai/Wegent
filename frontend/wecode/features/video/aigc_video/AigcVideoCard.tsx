// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronRight, Clock3, FileVideo, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  safeCardUrl,
  VideoDirectorGenerationCard,
} from '@/features/cards/VideoDirectorGenerationCard'
import type { CardRendererProps } from '@/features/cards/types'
import { openTaskRightPanel } from '@/features/tasks/components/right-panel'
import { useTranslation } from '@/hooks/useTranslation'
import type { AigcVideoPanelPayload } from './AigcVideoPanel'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from './mediaUrls'
import { parseAigcVideoCardData, type AigcVideoButton } from './types'

export default function AigcVideoCard({
  block: card,
  taskId,
  onChatButtonClick,
}: CardRendererProps) {
  const { t } = useTranslation('video')
  const [submitting, setSubmitting] = useState<string | null>(null)
  const previousStatusRef = useRef(card.card_status)
  const data = useMemo(() => parseAigcVideoCardData(card.card_data || {}), [card.card_data])
  const title = data.title || String(card.card_preview_data?.title || t('card.title'))
  const previewText = data.preview_content?.text || ''
  const buttons = useMemo(() => (Array.isArray(data.buttons) ? data.buttons : []), [data.buttons])
  const detailUrl = safeCardUrl(data.link)
  const canOpenPanel = Boolean(detailUrl || previewText)
  const videoUrl = safeCardUrl(data.video_url)
  const coverUrl = safeCardUrl(data.cover_url)
  const progress = Math.min(100, Math.max(0, Number(card.card_preview_data?.progress) || 0))
  const progressText =
    data.progress_text || String(card.card_preview_data?.progress_text || t('card.processing'))
  const isPending = card.card_status === 'pending'
  const isPartial = card.card_status === 'partial_ready'
  const isFailed = card.card_status === 'error'
  const previewVideoUrl =
    typeof card.card_preview_data?.video_url === 'string'
      ? safeCardUrl(card.card_preview_data.video_url)
      : null
  const previewCoverUrl =
    typeof card.card_preview_data?.cover_url === 'string'
      ? safeCardUrl(card.card_preview_data.cover_url)
      : null
  const usePublicMediaCard = Boolean(
    videoUrl || coverUrl || previewVideoUrl || previewCoverUrl || isFailed
  )
  const mediaCard = useMemo(
    () => ({
      ...card,
      card_data: {
        ...card.card_data,
        ...(typeof card.card_data.video_url === 'string'
          ? { video_url: getAigcVideoPlaybackUrl(card.card_data.video_url) }
          : {}),
        ...(typeof card.card_data.cover_url === 'string'
          ? { cover_url: getAigcVideoImageUrl(card.card_data.cover_url) }
          : {}),
      },
      card_preview_data: card.card_preview_data
        ? {
            ...card.card_preview_data,
            ...(typeof card.card_preview_data.video_url === 'string'
              ? {
                  video_url: getAigcVideoPlaybackUrl(card.card_preview_data.video_url),
                }
              : {}),
            ...(typeof card.card_preview_data.cover_url === 'string'
              ? {
                  cover_url: getAigcVideoImageUrl(card.card_preview_data.cover_url),
                }
              : {}),
          }
        : undefined,
    }),
    [card]
  )

  const openPanel = useCallback(() => {
    if (!canOpenPanel) return
    openTaskRightPanel({
      panelType: 'aigc-video',
      panelProps: {
        link: detailUrl || undefined,
        title,
        fallbackTaskId: taskId,
        previewText,
        buttons,
        onChatButtonClick,
      } satisfies AigcVideoPanelPayload,
    })
  }, [buttons, canOpenPanel, detailUrl, onChatButtonClick, previewText, taskId, title])

  useEffect(() => {
    const previous = previousStatusRef.current
    if (
      previous === 'pending' &&
      (card.card_status === 'partial_ready' || card.card_status === 'populated') &&
      canOpenPanel &&
      !document.querySelector('[data-task-right-panel]')
    ) {
      openPanel()
    }
    previousStatusRef.current = card.card_status
  }, [canOpenPanel, card.card_status, openPanel])

  const handleButton = async (button: AigcVideoButton) => {
    const buttonId = button.button_id || button.button_name
    if (button.button_type === 'link') {
      openPanel()
      return
    }
    if (!onChatButtonClick) return
    setSubmitting(buttonId)
    try {
      await onChatButtonClick(button.prompt || button.button_name)
    } finally {
      setSubmitting(null)
    }
  }

  const compactCard = isPending ? (
    <div
      className="w-full max-w-[342px] rounded-lg border border-border bg-surface p-4"
      data-testid="card-video-director-generation"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          <Progress value={progress} className="mt-2 h-1.5" />
          <div
            className="mt-1 flex justify-between gap-3 text-xs text-text-secondary"
            data-testid="card-video-director-progress"
          >
            <span className="truncate">{progressText}</span>
            <span>{progress}%</span>
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div className="w-full max-w-[342px]" data-testid="card-video-director-generation">
      {isPartial ? (
        <div
          className="mb-2 rounded-lg border border-border bg-surface px-4 py-2"
          data-testid="card-video-director-progress"
        >
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="min-w-0 flex-1 truncate">{progressText}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} className="mt-2 h-1" />
        </div>
      ) : null}

      {canOpenPanel ? (
        <button
          type="button"
          className="flex min-h-[72px] w-full items-center gap-3 rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:bg-muted/30"
          onClick={openPanel}
          data-testid="card-video-director-detail"
        >
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <FileVideo className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            {data.created_time ? (
              <span className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                <Clock3 className="h-3.5 w-3.5" />
                {new Date(data.created_time).toLocaleString()}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary">
            {t('card.viewEdit')}
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
      ) : (
        <div className="flex min-h-[72px] items-center gap-3 rounded-lg border border-border bg-surface p-4">
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <FileVideo className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            {data.created_time ? (
              <span className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                <Clock3 className="h-3.5 w-3.5" />
                {new Date(data.created_time).toLocaleString()}
              </span>
            ) : null}
          </span>
        </div>
      )}

      {!isPartial && buttons.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {buttons.map(button => {
            const buttonId = button.button_id || button.button_name
            return (
              <Button
                key={buttonId}
                variant="outline"
                size="sm"
                disabled={submitting === buttonId}
                onClick={() => void handleButton(button)}
                data-testid={`aigc-video-card-action-${buttonId}`}
              >
                {submitting === buttonId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {button.button_name}
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      {usePublicMediaCard ? (
        <VideoDirectorGenerationCard
          block={mediaCard}
          taskId={taskId}
          onChatButtonClick={onChatButtonClick}
          onDetailOpen={openPanel}
        />
      ) : (
        compactCard
      )}
    </>
  )
}
