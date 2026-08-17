// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Loader2, X } from 'lucide-react'
import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

const StoryboardPanel = dynamic(
  () =>
    import('../storyboard/StoryboardPanel').then(module => ({
      default: module.StoryboardPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        data-testid="video-storyboard-panel-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    ),
  }
)

export interface VideoPanelTarget {
  panel?: string
  scriptId?: number
  taskId?: number
  index: number
}

interface AigcVideoPanelProps {
  open: boolean
  link?: string
  title: string
  fallbackTaskId?: number
  onClose: () => void
  onGenerateFinalVideo?: () => void
  children: ReactNode
}

export function parseVideoPanelTarget(link?: string): VideoPanelTarget {
  if (!link) return { index: 0 }
  try {
    const url = new URL(
      link,
      typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    )
    const scriptId = Number(url.searchParams.get('scriptId') || url.searchParams.get('script_id'))
    const taskId = Number(url.searchParams.get('taskId') || url.searchParams.get('task_id'))
    const index = Number(url.searchParams.get('index') || 0)
    return {
      panel: url.searchParams.get('openPanel') || undefined,
      scriptId: Number.isInteger(scriptId) && scriptId > 0 ? scriptId : undefined,
      taskId: Number.isInteger(taskId) && taskId > 0 ? taskId : undefined,
      index: Number.isInteger(index) && index >= 0 ? index : 0,
    }
  } catch {
    return { index: 0 }
  }
}

export function AigcVideoPanel({
  open,
  link,
  title,
  fallbackTaskId,
  onClose,
  onGenerateFinalVideo,
  children,
}: AigcVideoPanelProps) {
  const { t } = useTranslation('video')
  if (!open) return null
  const target = parseVideoPanelTarget(link)
  const taskId = target.taskId ?? fallbackTaskId
  const isStoryboard =
    (target.panel === 'storyboard' || target.panel === 'storyboard-video') &&
    target.scriptId &&
    taskId

  return createPortal(
    <section
      data-wegent-panel
      className="fixed bottom-[10px] right-0 top-[56px] z-[60] flex w-full flex-col overflow-hidden rounded-l-lg border border-border bg-surface shadow-2xl md:w-[720px]"
      data-testid="aigc-video-panel"
    >
      {isStoryboard ? (
        <StoryboardPanel
          scriptId={target.scriptId!}
          taskId={taskId!}
          initialIndex={target.index}
          onClose={onClose}
          onGenerateFinalVideo={onGenerateFinalVideo}
        />
      ) : (
        <>
          <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium">{title}</h2>
              <p className="text-xs text-text-secondary">{t('panel.description')}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              data-testid="aigc-video-panel-close"
              aria-label={t('close')}
            >
              <X className="h-5 w-5" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </>
      )}
    </section>,
    document.body
  )
}
