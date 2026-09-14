// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Loader2, X } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import type { TaskRightPanelComponentProps } from '@/features/tasks/components/right-panel'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import type { AigcVideoButton } from './types'

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

const MaterialVideoPanel = dynamic(
  () =>
    import('../materials_to_video/MaterialVideoPanel').then(module => ({
      default: module.MaterialVideoPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        data-testid="material-video-panel-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    ),
  }
)

const EntityPanel = dynamic(
  () =>
    import('../entity/EntityPanel').then(module => ({
      default: module.EntityPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        data-testid="entity-panel-module-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    ),
  }
)

const ScriptPanel = dynamic(
  () =>
    import('../script/ScriptPanel').then(module => ({
      default: module.ScriptPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        data-testid="video-script-panel-module-loading"
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
  sessionId?: string
  taskUuid?: string
  index: number
}

export interface AigcVideoPanelPayload {
  link?: string
  title: string
  fallbackTaskId?: number
  previewText?: string
  buttons?: AigcVideoButton[]
  onChatButtonClick?: (message: string) => void | Promise<void>
  autoOpenOpenCut?: boolean
  shareToken?: string
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
      sessionId: url.searchParams.get('session_id') || undefined,
      taskUuid: url.searchParams.get('task_uuid') || undefined,
      index: Number.isInteger(index) && index >= 0 ? index : 0,
    }
  } catch {
    return { index: 0 }
  }
}

export function resolveVideoPanelSessionId(
  target: VideoPanelTarget,
  fallbackTaskId?: number
): string | undefined {
  if (target.sessionId) return target.sessionId
  if (target.panel !== 'timeline') return undefined

  const taskId = target.taskId ?? fallbackTaskId
  return taskId ? String(taskId) : undefined
}

export function AigcVideoPanel({
  panelProps,
  onClose,
  embedded,
}: TaskRightPanelComponentProps<AigcVideoPanelPayload>) {
  const { t } = useTranslation('video')
  const { theme } = useTheme()
  const [submitting, setSubmitting] = useState<string | null>(null)
  const {
    link,
    title,
    fallbackTaskId,
    previewText = '',
    buttons = [],
    onChatButtonClick,
    autoOpenOpenCut = false,
    shareToken,
  } = panelProps
  const target = parseVideoPanelTarget(link)
  const taskId = target.taskId ?? fallbackTaskId
  const sessionId = resolveVideoPanelSessionId(target, fallbackTaskId)
  const isStoryboard =
    (target.panel === 'storyboard' || target.panel === 'storyboard-video') &&
    target.scriptId &&
    taskId
  const isMaterialVideo =
    Boolean(sessionId) &&
    (target.panel === 'narrative-framework' ||
      target.panel === 'material-search' ||
      target.panel === 'timeline')
  const isEntity = target.panel === 'entity' && taskId
  const isScript = target.panel === 'script' && Boolean(target.scriptId)
  const chatButtons = shareToken ? [] : buttons.filter(button => button.button_type !== 'link')
  const finalVideoButton =
    chatButtons.find(button => /最终|合成|final/i.test(button.button_name)) ?? chatButtons.at(-1)

  const handleAction = async (button: AigcVideoButton) => {
    if (!onChatButtonClick) return
    const buttonId = button.button_id || button.button_name
    const message = button.prompt || button.button_name
    setSubmitting(buttonId)
    try {
      await onChatButtonClick(message)
    } finally {
      setSubmitting(null)
    }
  }

  const handleContinue = (buttonName?: string) => {
    const button =
      buttons.find(candidate => candidate.button_name === buttonName) ?? finalVideoButton
    const message = button?.prompt || buttonName || button?.button_name
    if (!message || !onChatButtonClick) return
    onClose()
    void onChatButtonClick(message)
  }

  return (
    <section
      data-wegent-panel
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface"
      data-testid="aigc-video-panel"
    >
      {isStoryboard ? (
        <StoryboardPanel
          scriptId={target.scriptId!}
          taskId={taskId!}
          initialIndex={target.index}
          onClose={onClose}
          embedded={embedded}
          readOnly={Boolean(shareToken)}
          shareToken={shareToken}
          onGenerateFinalVideo={
            !shareToken && onChatButtonClick ? () => handleContinue() : undefined
          }
        />
      ) : isScript ? (
        <ScriptPanel
          scriptId={target.scriptId!}
          onClose={onClose}
          readOnly={Boolean(shareToken)}
          shareToken={shareToken}
        >
          {chatButtons.length > 0 ? (
            <div className="w-full">
              {chatButtons.map(button => {
                const buttonId = button.button_id || button.button_name
                return (
                  <Button
                    key={buttonId}
                    variant="primary"
                    className="w-full"
                    onClick={() => handleContinue(button.button_name)}
                    data-testid={`aigc-video-panel-action-${buttonId}`}
                  >
                    {button.button_name}
                  </Button>
                )
              })}
            </div>
          ) : null}
        </ScriptPanel>
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
          <div className="min-h-0 flex-1 overflow-hidden">
            {isMaterialVideo ? (
              <MaterialVideoPanel
                panel={target.panel!}
                sessionId={sessionId}
                taskUuid={target.taskUuid}
                onContinue={onChatButtonClick ? handleContinue : undefined}
                onRender={
                  !shareToken && onChatButtonClick
                    ? () => onChatButtonClick(t('materialEditor.timeline.render'))
                    : undefined
                }
                autoOpenOpenCut={autoOpenOpenCut && target.panel === 'timeline'}
                onOpenCutClose={autoOpenOpenCut ? onClose : undefined}
              />
            ) : isEntity ? (
              <EntityPanel
                taskId={taskId!}
                readOnly={Boolean(shareToken)}
                shareToken={shareToken}
                onContinue={onChatButtonClick ? handleContinue : undefined}
              />
            ) : (
              <div className="h-full overflow-y-auto p-5">
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
                            onClick={() => void handleAction(button)}
                            data-testid={`aigc-video-panel-action-${buttonId}`}
                          >
                            {submitting === buttonId ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : null}
                            {button.button_name}
                          </Button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
