import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'
import { localConnectorAuthHealth } from '@/api/local/localConnectorAuth'
import { GITHUB_CLI_TARGET, isGithubCliTarget } from '@/api/local/githubCli'
import {
  latestConnectorAuthMessage,
  resolveLocalConnectorAuthHint,
} from '@/features/plugins/localConnectorAuthGate'
import type { WorkbenchMessage } from '@/types/workbench'
import { WORKBENCH_NEW_CHAT_STARTED_EVENT } from '@/lib/workbenchComposerFocus'

export interface PendingConnectorAuth {
  target: LocalConnectorAuthTarget
  title?: string
}

export function useLocalConnectorAuthRecovery(options: {
  messages: WorkbenchMessage[]
  onResumeSend: (input: string) => Promise<void> | void
  onError?: (message: string) => void
  active?: boolean
}) {
  const { t } = useTranslation('common')
  const active = options.active ?? true
  const [pending, setPending] = useState<PendingConnectorAuth | null>(null)
  const handledMessageIdsRef = useRef(new Set<string>())
  const pendingRef = useRef(pending)
  const pendingMessageIdRef = useRef<string | null>(null)
  const inFlightRef = useRef<{ messageId: string } | null>(null)
  const recoveryVersionRef = useRef(0)
  const optionsRef = useRef(options)
  const candidate = latestConnectorAuthMessage(options.messages)
  const hint = resolveLocalConnectorAuthHint(candidate?.text)
  const messageId = candidate?.message.id
  const messageStatus = candidate?.message.status
  const pluginKey = hint?.pluginKey
  const connectorSlug = hint?.connectorSlug

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  useEffect(() => {
    return () => {
      recoveryVersionRef.current += 1
      pendingRef.current = null
      pendingMessageIdRef.current = null
      inFlightRef.current = null
    }
  }, [])

  const invalidateRecovery = useCallback((consumeCurrentMessage: boolean) => {
    // A new submission or cancellation must consume the old failure before a
    // late health response or another render can reopen its authorization card.
    const previous = consumeCurrentMessage
      ? latestConnectorAuthMessage(optionsRef.current.messages)
      : null
    if (previous) handledMessageIdsRef.current.add(previous.message.id)
    if (consumeCurrentMessage && inFlightRef.current) {
      handledMessageIdsRef.current.add(inFlightRef.current.messageId)
    }
    recoveryVersionRef.current += 1
    pendingRef.current = null
    pendingMessageIdRef.current = null
    inFlightRef.current = null
    setPending(null)
  }, [])

  const clearPending = useCallback(() => invalidateRecovery(true), [invalidateRecovery])

  useEffect(() => {
    if (pendingRef.current && pendingMessageIdRef.current !== messageId) {
      invalidateRecovery(false)
    }
  }, [messageId, invalidateRecovery])

  useEffect(() => {
    if (active || (!pendingRef.current && !inFlightRef.current)) return
    // Pane focus and settings can temporarily deactivate the conversation.
    // Cancel its native session without dismissing the unresolved auth request.
    if (pendingMessageIdRef.current) {
      handledMessageIdsRef.current.delete(pendingMessageIdRef.current)
    }
    invalidateRecovery(false)
  }, [active, invalidateRecovery])

  useEffect(() => {
    window.addEventListener(WORKBENCH_NEW_CHAT_STARTED_EVENT, clearPending)
    return () => window.removeEventListener(WORKBENCH_NEW_CHAT_STARTED_EVENT, clearPending)
  }, [clearPending])

  useEffect(() => {
    if (!active || pending || !messageId || !pluginKey || !connectorSlug) return
    if (messageStatus !== 'done' && messageStatus !== 'failed') return
    if (handledMessageIdsRef.current.has(messageId)) return
    const version = recoveryVersionRef.current
    let cancelled = false
    const isCurrent = () =>
      !cancelled &&
      version === recoveryVersionRef.current &&
      !pendingRef.current &&
      !handledMessageIdsRef.current.has(messageId)
    const identifiedTarget = { pluginKey, connectorSlug }
    const githubCli = isGithubCliTarget(identifiedTarget)
    const target = githubCli ? GITHUB_CLI_TARGET : identifiedTarget
    const probe = { messageId }
    inFlightRef.current = probe

    void (async () => {
      try {
        // The executor resolves the current installed manifest by identity.
        // Recovery must never wait for an installed-plugin catalog refresh.
        const health = await localConnectorAuthHealth(target, { bypassCache: true })
        if (!isCurrent()) return
        handledMessageIdsRef.current.add(messageId)
        if (health.status === 'ok') return
        if (health.status !== 'need_login' && health.status !== 'need_scan') {
          optionsRef.current.onError?.(t('workbench.plugins_local_auth_health_failed'))
          return
        }
        const next = {
          target,
          ...(githubCli ? { title: t('workbench.github_cli_login_title') } : {}),
        }
        pendingMessageIdRef.current = messageId
        pendingRef.current = next
        setPending(next)
      } catch {
        if (!isCurrent()) return
        handledMessageIdsRef.current.add(messageId)
        optionsRef.current.onError?.(t('workbench.plugins_local_auth_health_failed'))
      } finally {
        if (inFlightRef.current === probe) inFlightRef.current = null
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, pending, messageId, messageStatus, pluginKey, connectorSlug, t])

  const completePending = useCallback(async () => {
    const current = pendingRef.current
    if (!current || current !== pending) return
    const latest = latestConnectorAuthMessage(optionsRef.current.messages)
    const canResume =
      optionsRef.current.active !== false && latest?.message.id === pendingMessageIdRef.current
    clearPending()
    if (!canResume) return
    await optionsRef.current.onResumeSend(t('workbench.plugins_local_auth_resume_prompt'))
  }, [pending, clearPending, t])

  return useMemo(
    () => ({ pending, clearPending, completePending }),
    [pending, clearPending, completePending]
  )
}
