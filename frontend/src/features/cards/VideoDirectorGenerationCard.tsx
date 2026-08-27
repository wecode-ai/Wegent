// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { ExternalLink, Film, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { VideoPlayer } from '@/features/tasks/components/message/VideoPlayer'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CardRendererProps,
  VideoDirectorCardButton,
  VideoDirectorCardData,
  VideoDirectorCardPreview,
} from './types'

interface VideoDirectorGenerationCardProps extends CardRendererProps {
  onDetailOpen?: (url: string) => void
}

export function safeCardUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeCardMediaUrl(value?: string): string | null {
  const absoluteUrl = safeCardUrl(value)
  if (absoluteUrl || !value?.startsWith('/')) return absoluteUrl

  try {
    const baseUrl = new URL('https://wegent.invalid')
    const relativeUrl = new URL(value, baseUrl)
    if (relativeUrl.origin !== baseUrl.origin) return null
    return `${relativeUrl.pathname}${relativeUrl.search}${relativeUrl.hash}`
  } catch {
    return null
  }
}

export function VideoDirectorGenerationCard({
  block,
  onChatButtonClick,
  onDetailOpen,
}: VideoDirectorGenerationCardProps) {
  const { t } = useTranslation('chat')
  const [pendingButtonId, setPendingButtonId] = useState<string | null>(null)
  const card = block.card_data as VideoDirectorCardData
  const preview = block.card_preview_data as VideoDirectorCardPreview
  const isFailed = block.card_status === 'error'
  const isCompleted = block.card_status === 'populated'
  const progress = Math.min(100, Math.max(0, preview.progress || 0))
  const title =
    card.title ||
    (isCompleted
      ? t('cards.video_director.completed')
      : preview.title || t('cards.video_director.title'))
  const detailUrl = safeCardUrl(card.link)
  const videoUrl = safeCardMediaUrl(card.video_url || preview.video_url)
  const coverUrl = safeCardMediaUrl(card.cover_url || preview.cover_url)
  const linkButtons = (card.buttons || [])
    .map(button => ({
      ...button,
      href: safeCardUrl(button.url || button.link),
    }))
    .filter(button => button.button_type === 'link' && button.href)
  const chatButtons = onChatButtonClick
    ? (card.buttons || []).filter(
        button => button.button_type === 'chat' && Boolean(button.button_name?.trim())
      )
    : []
  const showDetailLink =
    detailUrl !== null && !linkButtons.some(button => button.href === detailUrl)

  const handleChatButtonClick = async (button: VideoDirectorCardButton, index: number) => {
    const message = button.button_name?.trim()
    if (!message || !onChatButtonClick || pendingButtonId) return

    const buttonId = button.button_id || `chat-${index}`
    setPendingButtonId(buttonId)
    try {
      await onChatButtonClick(message)
    } finally {
      setPendingButtonId(null)
    }
  }

  return (
    <div
      className="w-full max-w-[359px] overflow-hidden rounded-xl border bg-card shadow-sm"
      data-testid="card-video-director-generation"
    >
      {videoUrl ? (
        <VideoPlayer
          videoUrl={videoUrl}
          coverUrl={coverUrl || undefined}
          duration={card.duration}
          className="max-w-none rounded-none"
          videoTestId="card-video-director-player"
        />
      ) : coverUrl ? (
        // Dynamic card media intentionally bypasses Next image optimization.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="aspect-video w-full object-cover"
          src={coverUrl}
          alt={title}
          data-testid="card-video-director-cover"
        />
      ) : null}

      <div className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            {isCompleted || isFailed ? (
              <Film className="h-5 w-5" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{title}</div>
            {card.created_time && (
              <div className="mt-1 text-xs text-muted-foreground">{card.created_time}</div>
            )}
          </div>
        </div>

        {card.preview_content?.text && (
          <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
            {card.preview_content.text}
          </p>
        )}

        {!isCompleted && !isFailed && (
          <div className="space-y-2" data-testid="card-video-director-progress">
            <div className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{preview.progress_text || t('cards.video_director.processing')}</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} />
          </div>
        )}

        {isFailed && (
          <p className="text-sm text-destructive" data-testid="card-video-director-error">
            {block.card_error || t('cards.video_director.failed')}
          </p>
        )}

        {(showDetailLink || linkButtons.length > 0 || chatButtons.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {chatButtons.map((button, index) => {
              const buttonId = button.button_id || `chat-${index}`
              const isPending = pendingButtonId === buttonId
              return (
                <Button
                  key={buttonId}
                  size="sm"
                  disabled={pendingButtonId !== null}
                  onClick={() => void handleChatButtonClick(button, index)}
                  data-testid={`card-video-director-chat-button-${index}`}
                >
                  {isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {button.button_name}
                </Button>
              )
            })}
            {linkButtons.map((button, index) => (
              <Button key={button.button_id || `${button.button_name}-${index}`} asChild size="sm">
                <a
                  href={button.href || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`card-video-director-button-${index}`}
                >
                  {button.button_name || t('cards.video_director.view_detail')}
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            ))}
            {showDetailLink &&
              (onDetailOpen ? (
                <Button
                  size="sm"
                  onClick={() => detailUrl && onDetailOpen(detailUrl)}
                  data-testid="card-video-director-detail"
                >
                  {t('cards.video_director.view_detail')}
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button asChild size="sm">
                  <a
                    href={detailUrl || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="card-video-director-detail"
                  >
                    {t('cards.video_director.view_detail')}
                    <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
