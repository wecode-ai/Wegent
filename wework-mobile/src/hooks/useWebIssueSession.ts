import { useCallback, useEffect, useRef, useState } from 'react'

import type { RuntimeSessionConfig } from '@/services/backendConfig'
import {
  createWebIssueSession,
  parseWebSessionMessage,
  WebIssueSessionError,
} from '@/services/webIssueSession'

export function useWebIssueSession(
  config: RuntimeSessionConfig,
  userId: number,
  bootstrapUrl: string,
  deliverGrant: (script: string) => void
) {
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const challenge = useRef<string | null>(null)
  const operation = useRef<AbortController | null>(null)
  const document = useRef<{ ready: boolean; url: string | null }>({ ready: false, url: null })
  const pendingMessage = useRef<{ data: string; sourceUrl: string } | null>(null)

  const resetSession = useCallback(() => {
    operation.current?.abort()
    operation.current = null
    challenge.current = null
    document.current = { ready: false, url: null }
    pendingMessage.current = null
    setErrorStatus(null)
  }, [])

  useEffect(() => {
    resetSession()
    return () => operation.current?.abort()
  }, [bootstrapUrl, resetSession, userId])

  const processMessage = useCallback(
    async (data: string, sourceUrl: string, mainDocumentUrl: string): Promise<void> => {
      const message = parseWebSessionMessage(data, sourceUrl, bootstrapUrl, mainDocumentUrl)
      if (!message) return
      if (message.type === 'wework.web-session.error') {
        if (message.nonce === challenge.current) setErrorStatus(message.status)
        return
      }
      if (challenge.current) return
      const controller = new AbortController()
      operation.current = controller
      challenge.current = message.nonce
      try {
        const script = await createWebIssueSession(config, message, userId, controller.signal)
        if (!controller.signal.aborted) deliverGrant(script)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setErrorStatus(cause instanceof WebIssueSessionError ? cause.status : 0)
        }
      }
    },
    [bootstrapUrl, config, deliverGrant, userId]
  )

  const receiveMessage = useCallback(
    async (data: string, sourceUrl: string): Promise<void> => {
      if (!parseWebSessionMessage(data, sourceUrl, bootstrapUrl, bootstrapUrl)) return
      if (!document.current.ready || !document.current.url) {
        pendingMessage.current = { data, sourceUrl }
        return
      }
      await processMessage(data, sourceUrl, document.current.url)
    },
    [bootstrapUrl, processMessage]
  )

  const startPage = useCallback(
    (url: string) => {
      // Android message and loading events use separate native channels.
      const buffered = document.current.ready ? null : pendingMessage.current
      resetSession()
      document.current = { ready: false, url }
      pendingMessage.current = buffered
    },
    [resetSession]
  )

  const finishPage = useCallback(
    async (url: string): Promise<void> => {
      document.current = { ready: true, url }
      const pending = pendingMessage.current
      pendingMessage.current = null
      if (pending) await processMessage(pending.data, pending.sourceUrl, url)
    },
    [processMessage]
  )

  return {
    errorStatus,
    receiveMessage,
    resetSession,
    startPage,
    finishPage,
    reportError: setErrorStatus,
  }
}
