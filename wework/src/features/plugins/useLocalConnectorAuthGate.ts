import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'
import {
  extractConnectorAuthPluginKey,
  findFirstLocalQrNeedingLogin,
  findLocalQrConnectorsForMessage,
  listLocalQrConnectors,
  messageRequiresConnectorAuth,
  toLocalConnectorAuthTarget,
  type LocalQrConnectorRequirement,
} from '@/features/plugins/localConnectorAuthGate'
import type { InstalledPlugin } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

export interface PendingConnectorAuth {
  target: LocalConnectorAuthTarget
  title: string
  mode: 'preflight' | 'resume'
  pendingInput?: string
  retryMessage?: WorkbenchMessage
}

function requirementTitle(requirement: LocalQrConnectorRequirement): string {
  return `扫码登录 ${requirement.displayName}`
}

async function loadInstalledPlugins(): Promise<InstalledPlugin[]> {
  const api = createLocalCodexPluginApi()
  const response = await api.listInstalledPlugins()
  return response.items ?? []
}

function messageText(message: WorkbenchMessage): string {
  const parts: string[] = [message.content, message.error ?? '']
  for (const block of message.blocks ?? []) {
    const maybeContent = Reflect.get(block, 'content')
    if (typeof maybeContent === 'string') parts.push(maybeContent)
    const maybeToolOutput = Reflect.get(block, 'toolOutput')
    if (typeof maybeToolOutput === 'string') parts.push(maybeToolOutput)
    else if (maybeToolOutput != null) {
      try {
        parts.push(JSON.stringify(maybeToolOutput))
      } catch {
        // ignore
      }
    }
    const renderPayload = Reflect.get(block, 'renderPayload')
    if (renderPayload && typeof renderPayload === 'object') {
      try {
        parts.push(JSON.stringify(renderPayload))
      } catch {
        // ignore
      }
    }
  }
  return parts.filter(Boolean).join('\n')
}

export function useLocalConnectorAuthGate(options: {
  messages: WorkbenchMessage[]
  onResumeSend: (input: string) => Promise<void> | void
  onRetryMessage: (message: WorkbenchMessage) => Promise<boolean> | boolean
}) {
  const [pending, setPending] = useState<PendingConnectorAuth | null>(null)
  const pluginsRef = useRef<InstalledPlugin[] | null>(null)
  const handledResumeKeysRef = useRef<Set<string>>(new Set())

  const refreshPlugins = useCallback(async () => {
    const plugins = await loadInstalledPlugins()
    pluginsRef.current = plugins
    return plugins
  }, [])

  const gateBeforeSend = useCallback(
    async (input: string): Promise<'send' | 'blocked'> => {
      if (pending) return 'blocked'
      try {
        const plugins = pluginsRef.current ?? (await refreshPlugins())
        const requirements = findLocalQrConnectorsForMessage(input, plugins)
        if (requirements.length === 0) return 'send'
        const needing = await findFirstLocalQrNeedingLogin(requirements)
        if (!needing) return 'send'
        setPending({
          target: toLocalConnectorAuthTarget(needing),
          title: requirementTitle(needing),
          mode: 'preflight',
          pendingInput: input,
        })
        return 'blocked'
      } catch {
        // If health gate fails unexpectedly, allow send and rely on mid-task resume.
        return 'send'
      }
    },
    [pending, refreshPlugins]
  )

  useEffect(() => {
    if (pending) return
    const latest = [...options.messages].reverse().find(message => {
      if (message.role !== 'assistant' && message.role !== 'system') return false
      return messageRequiresConnectorAuth(messageText(message))
    })
    if (!latest) return
    const key = latest.id
    if (handledResumeKeysRef.current.has(key)) return
    handledResumeKeysRef.current.add(key)

    void (async () => {
      try {
        const plugins = pluginsRef.current ?? (await refreshPlugins())
        const pluginKey = extractConnectorAuthPluginKey(messageText(latest))
        const requirements = pluginKey
          ? listLocalQrConnectors(plugins).filter(
              item =>
                item.pluginKey.toLowerCase() === pluginKey.toLowerCase() ||
                item.displayName.toLowerCase() === pluginKey.toLowerCase()
            )
          : listLocalQrConnectors(plugins, { authPolicies: ['on_install', 'on_use'] })
        const needing =
          (await findFirstLocalQrNeedingLogin(requirements)) ?? requirements[0] ?? null
        if (!needing) return
        setPending({
          target: toLocalConnectorAuthTarget(needing),
          title: requirementTitle(needing),
          mode: 'resume',
          retryMessage: latest,
        })
      } catch {
        // ignore detection failures
      }
    })()
  }, [options.messages, pending, refreshPlugins])

  const clearPending = useCallback(() => setPending(null), [])

  const completePending = useCallback(async () => {
    const current = pending
    setPending(null)
    if (!current) return
    if (current.mode === 'preflight' && current.pendingInput) {
      await options.onResumeSend(current.pendingInput)
      return
    }
    if (current.mode === 'resume') {
      if (current.retryMessage?.status === 'failed') {
        await options.onRetryMessage(current.retryMessage)
        return
      }
      const lastUser = [...options.messages].reverse().find(message => message.role === 'user')
      if (lastUser?.content) {
        await options.onResumeSend(lastUser.content)
      }
    }
  }, [options, pending])

  return useMemo(
    () => ({
      pending,
      gateBeforeSend,
      clearPending,
      completePending,
    }),
    [pending, gateBeforeSend, clearPending, completePending]
  )
}
