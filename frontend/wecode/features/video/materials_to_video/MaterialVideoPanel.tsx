// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { MaterialSearchPanel } from './MaterialSearchPanel'
import { MaterialTimelinePanel } from './MaterialTimelinePanel'
import { NarrativeFrameworkPanel } from './NarrativeFrameworkPanel'

interface MaterialVideoPanelProps {
  panel: string
  sessionId?: string
  taskUuid?: string
  onContinue?: (buttonName?: string) => void
  onRender?: () => void | Promise<void>
  autoOpenOpenCut?: boolean
  onOpenCutClose?: () => void
}

export function MaterialVideoPanel({
  panel,
  sessionId,
  taskUuid,
  onContinue,
  onRender,
  autoOpenOpenCut,
  onOpenCutClose,
}: MaterialVideoPanelProps) {
  const { t } = useTranslation('video')

  if (!sessionId || (panel !== 'timeline' && !taskUuid)) {
    return (
      <div className="flex min-h-48 items-center justify-center p-5 text-sm text-text-secondary">
        {t('materialEditor.invalidLink')}
      </div>
    )
  }

  if (panel === 'narrative-framework') {
    return (
      <NarrativeFrameworkPanel sessionId={sessionId} taskUuid={taskUuid!} onContinue={onContinue} />
    )
  }

  if (panel === 'material-search') {
    return (
      <MaterialSearchPanel sessionId={sessionId} taskUuid={taskUuid!} onContinue={onContinue} />
    )
  }

  return (
    <MaterialTimelinePanel
      sessionId={sessionId}
      onContinue={onContinue}
      onRender={onRender}
      autoOpenOpenCut={autoOpenOpenCut}
      onOpenCutClose={onOpenCutClose}
    />
  )
}
