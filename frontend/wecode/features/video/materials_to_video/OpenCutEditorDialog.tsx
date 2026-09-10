// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExternalLink, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { materialTimelineApi } from './api'
import { useOpenCutHostControls, withOpenCutHostControls } from './useOpenCutHostControls'

interface OpenCutEditorDialogProps {
  sessionId: string
  artifactId: string
  onSaved?: () => void
  onRender?: () => void | Promise<void>
  autoOpen?: boolean
  onDialogClose?: () => void
}

export function OpenCutEditorDialog({
  sessionId,
  artifactId,
  onSaved,
  onRender,
  autoOpen,
  onDialogClose,
}: OpenCutEditorDialogProps) {
  const { t } = useTranslation('video')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [openUrl, setOpenUrl] = useState('')
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)
  const autoOpenedTargetRef = useRef('')
  const [activeAction, setActiveAction] = useState<'save' | 'save-and-render' | null>(null)
  const actionRef = useRef(false)
  const identityRef = useRef(`${sessionId}:${artifactId}`)

  const closeEditor = useCallback(() => {
    requestIdRef.current += 1
    setOpen(false)
    setLoading(false)
    setOpenUrl('')
    setError('')
    setActiveAction(null)
    actionRef.current = false
    onDialogClose?.()
  }, [onDialogClose])

  useEffect(() => {
    const identity = `${sessionId}:${artifactId}`
    if (identityRef.current === identity) return
    identityRef.current = identity
    closeEditor()
  }, [artifactId, closeEditor, sessionId])

  useEffect(
    () => () => {
      requestIdRef.current += 1
    },
    []
  )

  const host = useOpenCutHostControls({ open, openUrl, onSaved, onClose: closeEditor })

  const handleSave = async (renderAfterSave: boolean) => {
    if (actionRef.current || (renderAfterSave && !onRender)) return
    actionRef.current = true
    const requestId = requestIdRef.current
    setActiveAction(renderAfterSave ? 'save-and-render' : 'save')
    let saved = false
    try {
      await host.save()
      saved = true
      if (requestId !== requestIdRef.current) return
      if (renderAfterSave) {
        await onRender?.()
        if (requestId !== requestIdRef.current) return
        toast({ description: t('materialEditor.timeline.savedAndRendering') })
        closeEditor()
      } else {
        toast({ description: t('materialEditor.timeline.saved') })
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      toast({
        variant: 'destructive',
        description: saved
          ? t('materialEditor.timeline.renderSubmitFailed')
          : error instanceof Error
            ? error.message
            : t('materialEditor.timeline.saveFailed'),
      })
    } finally {
      if (requestId === requestIdRef.current) {
        setActiveAction(null)
        actionRef.current = false
      }
    }
  }

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
      setOpenUrl(withOpenCutHostControls(result.open_url))
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
          preventEscapeClose
          preventOutsideClick
        >
          <DialogTitle className="sr-only">{t('materialEditor.timeline.openCutTitle')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('materialEditor.timeline.openCutDescription')}
          </DialogDescription>
          <div data-wegent-panel className="flex h-full min-h-0 w-full flex-col bg-[#111111]">
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
              <span className="text-sm text-text-primary">
                {t(
                  host.ready
                    ? 'materialEditor.timeline.openCutTitle'
                    : 'materialEditor.timeline.hostNotReady'
                )}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!host.ready || activeAction !== null}
                  onClick={() => void handleSave(false)}
                  data-testid="opencut-host-save"
                >
                  {t(
                    activeAction === 'save'
                      ? 'materialEditor.timeline.saving'
                      : 'materialEditor.save'
                  )}
                </Button>
                <Button
                  variant="primary"
                  className="min-h-11"
                  disabled={!host.ready || !onRender || activeAction !== null}
                  onClick={() => void handleSave(true)}
                  data-testid="opencut-host-save-render"
                >
                  {activeAction === 'save-and-render' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {t(
                    activeAction === 'save-and-render'
                      ? 'materialEditor.timeline.savingAndRendering'
                      : 'materialEditor.timeline.saveAndRender'
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11"
                  disabled={activeAction !== null}
                  onClick={closeEditor}
                  aria-label={t('materialEditor.timeline.openCutClose')}
                  data-testid="opencut-host-close"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </header>
            <div className="min-h-0 flex-1">
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
                  ref={host.frameRef}
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
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={closeEditor}
                    data-testid="opencut-load-error-close"
                  >
                    {t('materialEditor.timeline.openCutClose')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
