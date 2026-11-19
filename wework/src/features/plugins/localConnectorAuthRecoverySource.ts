import { isLocalConnectorPluginUnavailableError } from './waitForLocalConnectorAuthAvailability'
import type { TFunction } from 'i18next'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'
import { localConnectorAuthHealth } from '@/api/local/localConnectorAuth'
import { GITHUB_CLI_TARGET, isGithubCliTarget } from '@/api/local/githubCli'
import { latestConnectorAuthMessage, resolveConnectorAuthHint } from './localConnectorAuthGate'
import type { WorkbenchMessage } from '@/types/workbench'

export interface PendingConnectorAuth {
  target: LocalConnectorAuthTarget
  title?: string
  cloud?: { slug: string }
}

export interface ConnectorAuthRecoveryInput {
  messages: WorkbenchMessage[]
  onResumeSend(input: string): Promise<void> | void
  onError?(message: string): void
  active?: boolean
  cloudConnection?: { apiBaseUrl?: string | null; token?: string | null }
  t: TFunction
}

/** A conversation owns the unresolved native health request and its authorization card. */
export function createLocalConnectorAuthRecoverySource() {
  const listeners = new Set<() => void>()
  const handled = new Set<string>()
  let input: ConnectorAuthRecoveryInput | null = null
  let pending: PendingConnectorAuth | null = null
  let pendingMessageId: string | null = null
  let request: { messageId: string; version: number } | null = null
  let version = 0
  let scope: string | null = null

  const publish = () => listeners.forEach(listener => listener())
  const invalidate = (consume: boolean) => {
    if (consume) {
      const candidate = input && latestConnectorAuthMessage(input.messages)
      if (candidate) handled.add(candidate.message.id)
      if (request) handled.add(request.messageId)
    }
    version++
    request = null
    pendingMessageId = null
    if (pending) {
      pending = null
      publish()
    }
  }
  const clearPending = () => invalidate(true)

  function reconcile(next: ConnectorAuthRecoveryInput) {
    input = next
    const candidate = latestConnectorAuthMessage(next.messages)
    const messageId = candidate?.message.id
    const status = candidate?.message.status
    const hint = resolveConnectorAuthHint(candidate?.text)
    const nextScope = JSON.stringify([
      next.active !== false,
      messageId,
      status,
      hint?.pluginKey,
      hint?.connectorSlug,
      hint?.instance,
      hint?.displayName,
    ])
    if (scope !== nextScope) {
      scope = nextScope
      version++
      request = null
    }
    if (pending && pendingMessageId !== messageId) invalidate(false)
    if (next.active === false) {
      if (pendingMessageId) handled.delete(pendingMessageId)
      if (pending || request) invalidate(false)
      return
    }
    if (
      pending ||
      request ||
      !messageId ||
      !hint?.connectorSlug ||
      (status !== 'done' && status !== 'failed') ||
      handled.has(messageId)
    )
      return
    if (!hint.pluginKey) {
      const probe = { messageId, version }
      request = probe
      void Promise.resolve().then(() => {
        if (
          !listeners.size ||
          input?.active === false ||
          request !== probe ||
          version !== probe.version ||
          pending ||
          handled.has(messageId)
        )
          return
        request = null
        handled.add(messageId)
        pendingMessageId = messageId
        pending = {
          target: { pluginKey: '', connectorSlug: hint.connectorSlug },
          cloud: { slug: hint.connectorSlug },
        }
        publish()
      })
      return
    }
    const identifiedTarget = {
      pluginKey: hint.pluginKey,
      connectorSlug: hint.connectorSlug,
      ...(hint.instance ? { instance: hint.instance } : {}),
    }
    const githubCli = isGithubCliTarget(identifiedTarget)
    const target = githubCli ? GITHUB_CLI_TARGET : identifiedTarget
    const probe = { messageId, version }
    request = probe
    const isCurrent = () =>
      listeners.size > 0 &&
      input?.active !== false &&
      request === probe &&
      version === probe.version &&
      !pending &&
      !handled.has(messageId)
    void (async () => {
      try {
        // Native health resolves the installed manifest and validates the exact instance.
        const health = await localConnectorAuthHealth(target, {
          bypassCache: true,
          prepareRuntime: true,
        })
        if (!isCurrent()) return
        handled.add(messageId)
        if (health.status === 'ok') return
        if (health.status !== 'need_login' && health.status !== 'need_scan') {
          input?.onError?.(input.t('workbench.plugins_local_auth_health_failed'))
          return
        }
        pendingMessageId = messageId
        pending = {
          target,
          ...(githubCli ? { title: input!.t('workbench.github_cli_login_title') } : {}),
        }
        publish()
      } catch (error) {
        if (!isCurrent()) return
        handled.add(messageId)
        input?.onError?.(
          isLocalConnectorPluginUnavailableError(error)
            ? input.t('workbench.plugins_local_auth_plugin_missing', {
                plugin: hint.displayName ?? hint.pluginKey,
              })
            : input.t('workbench.plugins_local_auth_health_failed')
        )
      } finally {
        if (request === probe) request = null
      }
    })()
  }

  return {
    clearPending,
    async completePending(expected: PendingConnectorAuth | null) {
      if (!expected || pending !== expected || !input || !listeners.size) return
      const current = input
      const latest = latestConnectorAuthMessage(current.messages)
      const canResume = current.active !== false && latest?.message.id === pendingMessageId
      clearPending()
      if (canResume)
        await current.onResumeSend(current.t('workbench.plugins_local_auth_resume_prompt'))
    },
    observe(next: ConnectorAuthRecoveryInput) {
      const messageId = latestConnectorAuthMessage(next.messages)?.message.id
      return {
        getSnapshot: () =>
          next.active !== false && pendingMessageId === messageId ? pending : null,
        subscribe(listener: () => void) {
          listeners.add(listener)
          reconcile(next)
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (listeners.size) return
              invalidate(false)
              input = null
              scope = null
            })
          }
        },
      }
    },
  }
}
