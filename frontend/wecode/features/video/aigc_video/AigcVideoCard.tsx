// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import {
  safeCardUrl,
  VideoDirectorGenerationCard,
} from '@/features/cards/VideoDirectorGenerationCard'
import type { CardRendererProps } from '@/features/cards/types'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { AigcVideoPanel } from './AigcVideoPanel'
import { parseAigcVideoCardData, type AigcVideoButton } from './types'

export default function AigcVideoCard({
  block: card,
  taskId,
  onChatButtonClick,
}: CardRendererProps) {
  const { t } = useTranslation('video')
  const { theme } = useTheme()
  const [panelOpen, setPanelOpen] = useState(false)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const previousStatusRef = useRef(card.card_status)
  const data = parseAigcVideoCardData(card.card_data || {})
  const title = data.title || String(card.card_preview_data?.title || t('card.title'))
  const previewText = data.preview_content?.text || ''
  const buttons = Array.isArray(data.buttons) ? data.buttons : []
  const detailUrl = safeCardUrl(data.link)

  useEffect(() => {
    const previous = previousStatusRef.current
    if (
      previous === 'pending' &&
      (card.card_status === 'partial_ready' || card.card_status === 'populated') &&
      detailUrl &&
      !document.querySelector('[data-wegent-panel]')
    ) {
      setPanelOpen(true)
    }
    previousStatusRef.current = card.card_status
  }, [card.card_status, detailUrl])

  const handleButton = async (button: AigcVideoButton) => {
    const buttonId = button.button_id || button.button_name
    if (button.button_type === 'link') {
      if (detailUrl) setPanelOpen(true)
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

  const chatButtons = buttons.filter(button => button.button_type !== 'link')
  const finalVideoButton =
    chatButtons.find(button => /最终|合成|final/i.test(button.button_name)) ?? chatButtons.at(-1)

  return (
    <>
      <VideoDirectorGenerationCard
        block={card}
        taskId={taskId}
        onChatButtonClick={onChatButtonClick}
        onDetailOpen={() => setPanelOpen(true)}
      />

      <AigcVideoPanel
        open={panelOpen}
        link={detailUrl || undefined}
        title={title}
        fallbackTaskId={taskId}
        onClose={() => setPanelOpen(false)}
        onContinue={
          onChatButtonClick
            ? buttonName => {
                setPanelOpen(false)
                const button =
                  buttons.find(candidate => candidate.button_name === buttonName) ??
                  finalVideoButton
                const message = button?.prompt || buttonName || button?.button_name
                if (message) void onChatButtonClick(message)
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
