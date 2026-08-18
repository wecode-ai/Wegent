// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronRight, Clock3, FileVideo, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { Progress } from '@/components/ui/progress'
import type { AsyncCardComponentProps } from '@/features/cards/types'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { AigcVideoPanel } from './AigcVideoPanel'
import { parseAigcVideoCardData, type AigcVideoButton } from './types'

function progressValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
}

export default function AigcVideoCard({ card, taskId, onSendMessage }: AsyncCardComponentProps) {
  const { t } = useTranslation('video')
  const { theme } = useTheme()
  const [panelOpen, setPanelOpen] = useState(false)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const previousStatusRef = useRef(card.card_status)
  const data = parseAigcVideoCardData(card.card_data || {})
  const preview = card.card_preview_data || {}
  const progress = progressValue(preview.progress)
  const pending = card.card_status === 'pending'
  const partial = card.card_status === 'partial_ready'
  const title = data.title || String(preview.title || t('card.title'))
  const progressText = data.progress_text || String(preview.progress_text || '')
  const previewText = data.preview_content?.text || ''
  const buttons = Array.isArray(data.buttons) ? data.buttons : []

  useEffect(() => {
    const previous = previousStatusRef.current
    if (
      previous === 'pending' &&
      (card.card_status === 'partial_ready' || card.card_status === 'populated') &&
      data.link &&
      !document.querySelector('[data-wegent-panel]')
    ) {
      setPanelOpen(true)
    }
    previousStatusRef.current = card.card_status
  }, [card.card_status, data.link])

  const handleButton = async (button: AigcVideoButton) => {
    const buttonId = button.button_id || button.button_name
    if (button.button_type === 'link') {
      setPanelOpen(true)
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

  const chatButtons = buttons.filter(button => button.button_type !== 'link')
  const finalVideoButton =
    chatButtons.find(button => /最终|合成|final/i.test(button.button_name)) ?? chatButtons.at(-1)

  if (pending) {
    return (
      <div
        className="w-full max-w-[342px] rounded-lg border border-border bg-surface p-4"
        data-testid={`aigc-video-card-${card.card_id}`}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title}</div>
            <Progress value={progress} className="mt-2 h-1.5" />
            <div className="mt-1 text-xs text-text-secondary">
              {progressText || t('card.processing')} {progress}%
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <article
        className={`w-full max-w-[342px] overflow-hidden rounded-lg border border-border bg-surface ${
          data.link ? 'cursor-pointer transition-colors hover:bg-muted/30' : ''
        }`}
        onClick={() => data.link && setPanelOpen(true)}
        data-testid={`aigc-video-card-${card.card_id}`}
      >
        {partial ? (
          <div className="border-b border-border px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="min-w-0 flex-1 truncate">
                {progressText || t('card.processing')}
              </span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="mt-2 h-1" />
          </div>
        ) : null}
        <div className="flex min-h-[72px] items-center gap-3 p-4">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <FileVideo className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title}</div>
            {data.created_time ? (
              <div className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                <Clock3 className="h-3.5 w-3.5" />
                {new Date(data.created_time).toLocaleString()}
              </div>
            ) : null}
          </div>
          {data.link ? (
            <div className="flex items-center gap-1 text-xs text-text-secondary">
              {t('card.viewEdit')}
              <ChevronRight className="h-4 w-4" />
            </div>
          ) : null}
        </div>
      </article>

      {!partial && buttons.length > 0 ? (
        <div className="mt-2 flex max-w-[342px] flex-wrap gap-2">
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

      <AigcVideoPanel
        open={panelOpen}
        link={data.link}
        title={title}
        fallbackTaskId={taskId}
        onClose={() => setPanelOpen(false)}
        onContinue={
          onSendMessage
            ? buttonName => {
                setPanelOpen(false)
                const button =
                  buttons.find(candidate => candidate.button_name === buttonName) ??
                  finalVideoButton
                const message = button?.prompt || buttonName || button?.button_name
                if (message) onSendMessage(message)
              }
            : undefined
        }
      >
        <div className="space-y-4">
          {previewText ? (
            <div className="rounded-lg border border-border/50 bg-muted/30 p-4 text-sm leading-6 text-text-primary [&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:my-1 [&_ol]:mb-3 [&_p]:mb-3 [&_ul]:mb-3">
              <EnhancedMarkdown source={previewText} theme={theme} />
            </div>
          ) : (
            <div className="text-sm text-text-secondary">{t('panel.noPreview')}</div>
          )}
          {buttons.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {buttons.map(button => {
                const buttonId = button.button_id || button.button_name
                return (
                  <Button
                    key={buttonId}
                    disabled={submitting === buttonId}
                    onClick={() => void handleButton(button)}
                    data-testid={`aigc-video-panel-action-${buttonId}`}
                  >
                    {button.button_name}
                  </Button>
                )
              })}
            </div>
          ) : null}
        </div>
      </AigcVideoPanel>
    </>
  )
}
