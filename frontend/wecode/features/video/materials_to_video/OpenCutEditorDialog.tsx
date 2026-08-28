// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExternalLink, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { materialTimelineApi } from './api'

interface OpenCutEditorDialogProps {
  sessionId: string
  artifactId: string
  onSaved?: () => void
  autoOpen?: boolean
  onDialogClose?: () => void
}

export function OpenCutEditorDialog({
  sessionId,
  artifactId,
  onSaved,
  autoOpen,
  onDialogClose,
}: OpenCutEditorDialogProps) {
  const { t } = useTranslation('video')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [openUrl, setOpenUrl] = useState('')
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)
  const autoOpenedTargetRef = useRef('')

  const closeEditor = useCallback(() => {
    requestIdRef.current += 1
    setOpen(false)
    setLoading(false)
    setOpenUrl('')
    setError('')
    onDialogClose?.()
  }, [onDialogClose])

  const openEditor = useCallback(async () => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setOpen(true)
    setLoading(true)
    setOpenUrl('')
    setError('')

    try {
      const result = await materialTimelineApi.openInOpenCut(sessionId, artifactId)
      if (requestIdRef.current !== requestId) return
      if (!result.open_url) throw new Error(t('materialEditor.timeline.openCutLoadFailed'))
      setOpenUrl(result.open_url)
    } catch (requestError) {
      if (requestIdRef.current !== requestId) return
      setError(
        requestError instanceof Error
          ? requestError.message
          : t('materialEditor.timeline.openCutLoadFailed')
      )
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [artifactId, sessionId, t])

  useEffect(() => {
    if (!autoOpen) return
    const target = `${sessionId}:${artifactId}`
    if (autoOpenedTargetRef.current === target) return
    autoOpenedTargetRef.current = target
    void openEditor()
  }, [artifactId, autoOpen, openEditor, sessionId])

  useEffect(() => {
    if (!open) return

    const handleMessage = (event: MessageEvent) => {
      if (!openUrl || event.origin !== new URL(openUrl).origin) return
      if (!event.data || typeof event.data !== 'object') return
      const messageType = (event.data as { type?: string }).type
      if (messageType === 'storycut:opencut-saved') onSaved?.()
      if (messageType === 'storycut:opencut-close') closeEditor()
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [closeEditor, onSaved, open, openUrl])

  return (
    <>
      <Button
        variant="outline"
        className="min-h-11"
        onClick={() => void openEditor()}
        disabled={loading}
        data-testid="material-timeline-open-opencut"
      >
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ExternalLink className="mr-2 h-4 w-4" />
        )}
        {t('materialEditor.timeline.openCut')}
      </Button>

      <Dialog
        open={open}
        onOpenChange={nextOpen => {
          if (!nextOpen) closeEditor()
        }}
      >
        <DialogContent
          className="fixed inset-0 left-0 top-0 z-[9999] flex h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-[#111111] p-0 shadow-none"
          hideCloseButton
        >
          <DialogTitle className="sr-only">{t('materialEditor.timeline.openCutTitle')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('materialEditor.timeline.openCutDescription')}
          </DialogDescription>
          <div data-wegent-panel className="h-full min-h-0 w-full bg-[#111111]">
            {loading ? (
              <div
                className="flex h-full items-center justify-center gap-2 text-sm text-white/70"
                data-testid="material-timeline-opencut-loading"
              >
                <Loader2 className="h-5 w-5 animate-spin" />
                {t('materialEditor.timeline.openCutLoading')}
              </div>
            ) : openUrl ? (
              <iframe
                src={openUrl}
                title={t('materialEditor.timeline.openCutTitle')}
                className="h-full w-full border-0"
                allow="autoplay; clipboard-read; clipboard-write; fullscreen"
                allowFullScreen
                data-testid="material-timeline-opencut-frame"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-sm text-white/70">
                <span data-testid="material-timeline-opencut-error">
                  {error || t('materialEditor.timeline.openCutLoadFailed')}
                </span>
                <Button variant="outline" className="min-h-11" onClick={closeEditor}>
                  {t('materialEditor.timeline.openCutClose')}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
