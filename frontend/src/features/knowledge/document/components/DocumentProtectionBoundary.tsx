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
  children,
}: {
  watermarkText: string
  children: ReactNode
}) {
  const [watermarkPattern, setWatermarkPattern] = useState<string | null>(null)

  useEffect(() => {
    try {
      setWatermarkPattern(createWatermarkPattern(watermarkText))
    } catch {
      setWatermarkPattern(null)
    }
  }, [watermarkText])

  return (
    <div
      className="relative h-full overflow-hidden select-none"
      onCopy={preventExtraction}
      onCut={preventExtraction}
      onContextMenu={preventExtraction}
      onDragStart={preventExtraction}
      data-testid="knowledge-protected-content"
    >
      {children}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20"
        style={{ backgroundImage: watermarkPattern ? `url(${watermarkPattern})` : undefined }}
        data-testid="knowledge-document-watermark"
        data-watermark-pattern="tiled"
      />
    </div>
  )
}

export function DocumentProtectionBoundary({
  enabled,
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

  if (!enabled) return children
  if (preferExtension && extension) {
    return extension.renderBoundary({ knowledgeBaseId, children })
  }
  if (preferExtension && isKnowledgeDocumentProtectionRequired()) {
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
    <CoreProtectedKnowledgePreview watermarkText={watermarkText}>
      {children}
    </CoreProtectedKnowledgePreview>
  )
}
