// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Clock3, ExternalLink, Film, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { CardPanel } from '@/features/cards/components/CardPanel'
import type { AsyncCardComponentProps } from '@/features/cards/types'
import VideoPlayer from '@/features/tasks/components/message/VideoPlayer'
import { useTranslation } from '@/hooks/useTranslation'
import { getAigcVideoPlaybackUrl, parseAigcVideoCardData, type AigcVideoButton } from './types'

function getNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
}

export default function AigcVideoCard({ card, onSendMessage }: AsyncCardComponentProps) {
  const { t } = useTranslation('chat')
  const [panelOpen, setPanelOpen] = useState(false)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const data = parseAigcVideoCardData(card.card_data || {})
  const preview = card.card_preview_data || {}
  const progress = getNumber(preview.progress)
  const isPending = card.card_status === 'pending'
  const isPartial = card.card_status === 'partial_ready'
  const title = data.title || String(preview.title || t('asyncCards.videoTitle'))
  const progressText = data.progress_text || String(preview.progress_text || '')
  const previewText = data.preview_content?.text || ''
  const buttons = Array.isArray(data.buttons) ? data.buttons : []

  const handleButton = async (button: AigcVideoButton) => {
    const buttonId = button.button_id || button.button_name
    if (button.button_type === 'link' && (button.link || data.link)) {
      window.open(button.link || data.link, '_blank', 'noopener,noreferrer')
      return
    }
    if (!onSendMessage) return
    setSubmitting(buttonId)
    try {
      onSendMessage(button.prompt || button.button_name)
    } finally {
      setSubmitting(null)
    }
  }

  const cardBody = (
    <div className="space-y-4">
      {data.video_url ? (
        <VideoPlayer
          videoUrl={getAigcVideoPlaybackUrl(data.video_url)}
          coverUrl={data.cover_url}
          duration={data.duration}
        />
      ) : null}
      {previewText ? (
        <div className="whitespace-pre-wrap text-sm leading-6 text-text-primary">{previewText}</div>
      ) : null}
      {buttons.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {buttons.map(button => {
            const buttonId = button.button_id || button.button_name
            return (
              <Button
                key={buttonId}
                size="sm"
                disabled={isPending || isPartial || submitting === buttonId}
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
      <article
        className="max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
        data-testid={`aigc-video-card-${card.card_id}`}
      >
        <div className="flex items-start gap-3 p-4">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Film className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-primary">{title}</div>
            {progressText ? (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                {isPending || isPartial ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {progressText}
              </div>
            ) : null}
            {(isPending || isPartial) && (
              <div className="mt-3 space-y-1">
                <Progress value={progress} className="h-1.5" />
                <div className="text-right text-xs tabular-nums text-text-muted">{progress}%</div>
              </div>
            )}
            {previewText ? (
              <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
                {previewText}
              </p>
            ) : null}
            {data.created_time ? (
              <div className="mt-2 flex items-center gap-1 text-xs text-text-muted">
                <Clock3 className="h-3.5 w-3.5" />
                {data.created_time}
              </div>
            ) : null}
          </div>
        </div>
        {!isPending && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPanelOpen(true)}
              data-testid={`aigc-video-card-details-${card.card_id}`}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t('asyncCards.viewDetails')}
            </Button>
            {buttons.map(button => {
              const buttonId = button.button_id || button.button_name
              return (
                <Button
                  key={buttonId}
                  size="sm"
                  disabled={isPartial || submitting === buttonId}
                  onClick={() => void handleButton(button)}
                  data-testid={`aigc-video-card-inline-action-${buttonId}`}
                >
                  {button.button_name}
                </Button>
              )
            })}
          </div>
        )}
      </article>
      <CardPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        title={title}
        description={t('asyncCards.panelDescription')}
      >
        {cardBody}
      </CardPanel>
    </>
  )
}
