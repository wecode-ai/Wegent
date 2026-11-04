// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getKnowledgeDocumentProtectionExtension,
  isKnowledgeDocumentProtectionRequired,
  subscribeKnowledgeDocumentProtectionExtension,
} from '../document-protection-registry'

interface DocumentProtectionBoundaryProps {
  enabled: boolean
  /** Show the built-in watermark without enabling extraction guards. */
  showWatermark?: boolean
  knowledgeBaseId: number
  children: ReactNode
  /** Let an internal deployment supply its organization-specific preview. */
  preferExtension?: boolean
  /** Text used by the open-source fallback watermark. */
  watermarkText?: string
}

function createWatermarkPattern(text: string): string {
  const width = 280
  const height = 180
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.width = width * ratio
  canvas.height = height * ratio
  const context = canvas.getContext('2d')
  if (!context) throw new Error('WATERMARK_CANVAS_UNAVAILABLE')

  context.scale(ratio, ratio)
  context.translate(width / 2, height / 2)
  context.rotate((-25 * Math.PI) / 180)
  context.font = '16px sans-serif'
  context.fillStyle = 'rgba(80, 80, 80, 0.18)'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, 0, 0)
  return canvas.toDataURL('image/png')
}

function preventExtraction(event: SyntheticEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function CoreProtectedKnowledgePreview({
  watermarkText,
  protectedMode,
  children,
}: {
  watermarkText: string
  protectedMode: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('knowledge')
  const [generation, setGeneration] = useState<{
    text: string
    pattern: string | null
    failed: boolean
  }>({ text: '', pattern: null, failed: false })
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    try {
      setGeneration({
        text: watermarkText,
        pattern: createWatermarkPattern(watermarkText),
        failed: false,
      })
    } catch {
      setGeneration({ text: watermarkText, pattern: null, failed: true })
    }
  }, [retryKey, watermarkText])

  if (generation.text !== watermarkText || !generation.pattern) {
    return (
      <div
        className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-sm text-text-secondary"
        data-testid={
          generation.failed ? 'knowledge-watermark-unavailable' : 'knowledge-watermark-loading'
        }
      >
        <span>
          {t(
            generation.failed
              ? 'document.document.detail.linkPreview.watermarkUnavailable'
              : 'document.document.detail.linkPreview.watermarkLoading'
          )}
        </span>
        {generation.failed && (
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-4 py-2 text-text-primary"
            onClick={() => setRetryKey(key => key + 1)}
            data-testid="knowledge-watermark-retry"
          >
            {t('document.document.detail.linkPreview.retry')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`relative h-full overflow-hidden ${protectedMode ? 'select-none' : ''}`}
      onCopy={protectedMode ? preventExtraction : undefined}
      onCut={protectedMode ? preventExtraction : undefined}
      onContextMenu={protectedMode ? preventExtraction : undefined}
      onDragStart={protectedMode ? preventExtraction : undefined}
      data-testid={protectedMode ? 'knowledge-protected-content' : 'knowledge-watermarked-content'}
    >
      {children}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20"
        style={{ backgroundImage: `url(${generation.pattern})` }}
        data-testid="knowledge-document-watermark"
        data-watermark-pattern="tiled"
        data-watermark-text={watermarkText}
      />
    </div>
  )
}

export function DocumentProtectionBoundary({
  enabled,
  showWatermark = false,
  knowledgeBaseId,
  children,
  preferExtension = false,
  watermarkText = 'Protected',
}: DocumentProtectionBoundaryProps) {
  const { t } = useTranslation('knowledge')
  const extension = useSyncExternalStore(
    subscribeKnowledgeDocumentProtectionExtension,
    getKnowledgeDocumentProtectionExtension,
    getKnowledgeDocumentProtectionExtension
  )

  if (!enabled && !showWatermark) return children
  if (enabled && preferExtension && extension) {
    return extension.renderBoundary({ knowledgeBaseId, children })
  }
  if (enabled && preferExtension && isKnowledgeDocumentProtectionRequired()) {
    return (
      <div
        className="flex h-full min-h-[200px] items-center justify-center text-sm text-red-600"
        data-testid="protected-document-extension-unavailable"
      >
        {t('document.document.detail.protectedViewerUnavailable')}
      </div>
    )
  }
  return (
    <CoreProtectedKnowledgePreview watermarkText={watermarkText} protectedMode={enabled}>
      {children}
    </CoreProtectedKnowledgePreview>
  )
}
