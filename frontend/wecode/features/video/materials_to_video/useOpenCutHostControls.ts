// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

const PROTOCOL_VERSION = 1
export const OPENCUT_SAVE_TIMEOUT_MS = 120_000

interface PendingSave {
  requestId: string
  resolve: () => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

export function withOpenCutHostControls(value: string): string {
  const url = new URL(value)
  url.searchParams.set('controlMode', 'host-v1')
  url.searchParams.set('hostActions', 'save,save-and-render,close')
  return url.toString()
}

export function useOpenCutHostControls({
  open,
  openUrl,
  onSaved,
  onClose,
}: {
  open: boolean
  openUrl: string
  onSaved?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('video')
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const pendingRef = useRef<PendingSave | null>(null)
  const sequenceRef = useRef(0)
  const [ready, setReady] = useState(false)
  const callbacks = useRef({ onSaved, onClose, t })
  callbacks.current = { onSaved, onClose, t }

  const cancelPending = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    clearTimeout(pending.timeoutId)
    pending.reject(new Error(callbacks.current.t('materialEditor.timeline.saveCancelled')))
  }, [])

  useEffect(() => {
    setReady(false)
    if (!open || !openUrl) return
    const origin = new URL(openUrl).origin
    const handleMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow || event.origin !== origin) return
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'storycut:opencut-close') {
        callbacks.current.onClose()
        return
      }
      if (message.type === 'storycut:opencut-saved') {
        callbacks.current.onSaved?.()
        return
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) return
      if (message.type === 'storycut:opencut-ready') {
        if (!Array.isArray(message.capabilities) || !message.capabilities.includes('save')) return
        frameWindow.postMessage(
          { type: 'storycut:host-ready', protocolVersion: PROTOCOL_VERSION },
          origin
        )
      } else if (message.type === 'storycut:opencut-host-ready') {
        setReady(true)
      } else if (message.type === 'storycut:opencut-save-result') {
        const pending = pendingRef.current
        if (!pending || message.requestId !== pending.requestId) return
        pendingRef.current = null
        clearTimeout(pending.timeoutId)
        if (message.ok === true) {
          pending.resolve()
        } else {
          pending.reject(
            new Error(
              typeof message.error === 'string'
                ? message.error
                : callbacks.current.t('materialEditor.timeline.saveFailed')
            )
          )
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      cancelPending()
    }
  }, [cancelPending, open, openUrl])

  const save = useCallback(async () => {
    const frameWindow = frameRef.current?.contentWindow
    if (!ready || !frameWindow || !openUrl) {
      throw new Error(callbacks.current.t('materialEditor.timeline.hostNotReady'))
    }
    if (pendingRef.current) throw new Error(callbacks.current.t('materialEditor.timeline.saving'))
    const requestId = `opencut-save-${Date.now()}-${++sequenceRef.current}`
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (pendingRef.current?.requestId !== requestId) return
        pendingRef.current = null
        reject(new Error(callbacks.current.t('materialEditor.timeline.saveTimeout')))
      }, OPENCUT_SAVE_TIMEOUT_MS)
      pendingRef.current = { requestId, resolve, reject, timeoutId }
      frameWindow.postMessage(
        { type: 'storycut:host-save-request', protocolVersion: PROTOCOL_VERSION, requestId },
        new URL(openUrl).origin
      )
    })
    callbacks.current.onSaved?.()
  }, [openUrl, ready])

  return { frameRef, ready, save }
}
