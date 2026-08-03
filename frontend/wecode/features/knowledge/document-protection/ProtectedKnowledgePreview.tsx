// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useWecodeTranslation } from '@wecode/i18n/useWecodeTranslation'
import { ApiError } from '@/apis/client'
import { getDocumentProtection, type DocumentProtectionContext } from './api'
import { createWatermarkPattern } from './createWatermarkPattern'

interface ProtectedKnowledgePreviewProps {
  knowledgeBaseId: number
  children: ReactNode
}

const blockedEvents = ['copy', 'cut', 'contextmenu', 'dragstart'] as const

export function ProtectedKnowledgePreview({
  knowledgeBaseId,
  children,
}: ProtectedKnowledgePreviewProps) {
  const { t } = useWecodeTranslation()
  const [protection, setProtection] = useState<DocumentProtectionContext | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setProtection(null)
    setErrorCode(null)
    getDocumentProtection(knowledgeBaseId)
      .then(result => {
        if (active) setProtection(result)
      })
      .catch(error => {
        if (!active) return
        setErrorCode(
          error instanceof ApiError && error.errorCode
            ? String(error.errorCode)
            : 'DOCUMENT_PROTECTION_LOAD_FAILED'
        )
      })
    return () => {
      active = false
    }
  }, [knowledgeBaseId])

  const watermarkImage = useMemo(() => {
    if (!protection?.watermark) return null
    return createWatermarkPattern(
      `${protection.watermark.display_name} ${protection.watermark.employee_id}`
    )
  }, [protection])

  if (
    errorCode ||
    (protection && (!protection.protected || !protection.watermark || !watermarkImage))
  ) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-red-600"
        data-testid="protected-document-load-failed"
      >
        <AlertCircle className="h-5 w-5" />
        {t(
          errorCode === 'WATERMARK_IDENTITY_INCOMPLETE'
            ? 'documentProtection.identityIncomplete'
            : 'documentProtection.loadFailed'
        )}
      </div>
    )
  }
  if (!protection) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const preventExtraction = (event: React.SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div
      className="relative h-full overflow-hidden select-none"
      onCopy={preventExtraction}
      onCut={preventExtraction}
      onContextMenu={preventExtraction}
      onDragStart={preventExtraction}
      data-blocked-events={blockedEvents.join(',')}
      data-testid="protected-knowledge-preview"
    >
      {children}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20"
        style={{ backgroundImage: `url(${watermarkImage})` }}
        data-testid="protected-document-watermark"
      />
    </div>
  )
}
