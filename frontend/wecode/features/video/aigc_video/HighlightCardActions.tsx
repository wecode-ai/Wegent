// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { OpenCutEditorDialog } from '../materials_to_video/OpenCutEditorDialog'

interface HighlightCardActionsProps {
  data: Record<string, unknown>
  onChatButtonClick?: (message: string) => void | Promise<void>
}

export function HighlightCardActions({ data, onChatButtonClick }: HighlightCardActionsProps) {
  const { t } = useTranslation('video')
  const editor = data.opencut
  if (data.editor_type !== 'opencut' || !editor || typeof editor !== 'object') return null
  const { session_id: sessionId, artifact_id: artifactId } = editor as Record<string, unknown>
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof artifactId !== 'string' ||
    !artifactId.trim()
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="highlight-card-actions">
      <OpenCutEditorDialog
        sessionId={sessionId.trim()}
        artifactId={artifactId.trim()}
        onRender={
          onChatButtonClick
            ? () => onChatButtonClick(t('highlightActions.renderRequest'))
            : undefined
        }
      />
    </div>
  )
}
