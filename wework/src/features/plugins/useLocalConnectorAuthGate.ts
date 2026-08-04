import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  localConnectorAuthHealth,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import {
  enrichInstalledPluginsForLocalAuth,
  extractConnectorAuthConnectorSlug,
  extractConnectorAuthPluginKey,
  filterLocalRequirements,
  findFirstLocalNeedingLogin,
  findLocalConnectorsForMessage,
  messageRequiresConnectorAuth,
  resolveLocalConnectorAuthHint,
  toLocalConnectorAuthTarget,
  type LocalConnectorRequirement,
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

function requirementTitle(requirement: LocalConnectorRequirement): string {
  return requirement.localAuth.kind === 'browser_oauth'
    ? `授权 ${requirement.displayName}`
    : `扫码登录 ${requirement.displayName}`
}

function hintTitle(displayName: string): string {
  return `扫码登录 ${displayName}`
}

function installedPluginLookupId(plugin: InstalledPlugin): string {
  const labelId = Reflect.get(plugin.metadata.labels ?? {}, 'id')
  if (typeof labelId === 'string' && labelId.trim()) return labelId.trim()
  if (typeof labelId === 'number') return String(labelId)
  return String(plugin.metadata.name)
}

async function loadInstalledPlugins(): Promise<InstalledPlugin[]> {
  const api = createLocalCodexPluginApi()
  const response = await api.listInstalledPlugins()
  const items = response.items ?? []
  return enrichInstalledPluginsForLocalAuth(items, plugin =>
    api.readInstalledPluginForTrial(installedPluginLookupId(plugin))
  )
}

function messageText(message: WorkbenchMessage): string {
  const parts: string[] = [message.content, message.error ?? '']
  for (const block of message.blocks ?? []) {
    const maybeContent = Reflect.get(block, 'content')
    if (typeof maybeContent === 'string') parts.push(maybeContent)
    const maybeToolOutput = Reflect.get(block, 'toolOutput') ?? Reflect.get(block, 'tool_output')
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

async function targetNeedsLogin(target: LocalConnectorAuthTarget): Promise<boolean> {
  try {
    const health = await localConnectorAuthHealth(target)
    return health.status !== 'ok'
  } catch {
    // If health cannot run, still show the card so the user can recover.
    return true
  }
}

export function useLocalConnectorAuthGate(options: {
  messages: WorkbenchMessage[]
  onResumeSend: (input: string) => Promise<void> | void
  onRetryMessage: (message: WorkbenchMessage) => Promise<boolean> | boolean
}) {
  const [pending, setPending] = useState<PendingConnectorAuth | null>(null)
  const pluginsRef = useRef<InstalledPlugin[] | null>(null)
  const handledResumeKeysRef = useRef<Set<string>>(new Set())
  const pendingRef = useRef(pending)
  const optionsRef = useRef(options)

  useEffect(() => {
    pendingRef.current = pending
    optionsRef.current = options
  }, [options, pending])

  const refreshPlugins = useCallback(async () => {
    const plugins = await loadInstalledPlugins()
    pluginsRef.current = plugins
    return plugins
  }, [])

  const gateBeforeSend = useCallback(
    async (input: string): Promise<'send' | 'blocked'> => {
      if (pendingRef.current) return 'blocked'
      try {
        const plugins = pluginsRef.current ?? (await refreshPlugins())
        const requirements = findLocalConnectorsForMessage(input, plugins)
        if (requirements.length === 0) {
          const hint = resolveLocalConnectorAuthHint(input)
          if (!hint) return 'send'
          const target: LocalConnectorAuthTarget = {
            pluginKey: hint.pluginKey,
            connectorSlug: hint.connectorSlug,
          }
          if (!(await targetNeedsLogin(target))) return 'send'
          setPending({
            target,
            title: hintTitle(hint.displayName),
            mode: 'preflight',
            pendingInput: input,
          })
          return 'blocked'
        }
        const needing = await findFirstLocalNeedingLogin(requirements)
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
    [refreshPlugins]
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

    void (async () => {
      try {
        const text = messageText(latest)
        const plugins = pluginsRef.current ?? (await refreshPlugins())
        const requirements = filterLocalRequirements(plugins, {
          pluginKey: extractConnectorAuthPluginKey(text),
          connectorSlug: extractConnectorAuthConnectorSlug(text),
        })
        const needing = (await findFirstLocalNeedingLogin(requirements)) ?? requirements[0] ?? null
        if (needing) {
          handledResumeKeysRef.current.add(key)
          setPending({
            target: toLocalConnectorAuthTarget(needing),
            title: requirementTitle(needing),
            mode: 'resume',
            retryMessage: latest,
          })
          return
        }

        const hint = resolveLocalConnectorAuthHint(text)
        if (!hint) return
        const target: LocalConnectorAuthTarget = {
          pluginKey: hint.pluginKey,
          connectorSlug: hint.connectorSlug,
        }
        if (!(await targetNeedsLogin(target))) return
        handledResumeKeysRef.current.add(key)
        setPending({
          target,
          title: hintTitle(hint.displayName),
          mode: 'resume',
          retryMessage: latest,
        })
      } catch {
        // ignore detection failures; leave unhandled so a later refresh can retry
      }
    })()
  }, [options.messages, pending, refreshPlugins])

  const clearPending = useCallback(() => setPending(null), [])

  const completePending = useCallback(async () => {
    const current = pendingRef.current
    setPending(null)
    if (!current) return
    if (current.mode === 'preflight' && current.pendingInput) {
      await optionsRef.current.onResumeSend(current.pendingInput)
      return
    }
    if (current.mode === 'resume') {
      if (current.retryMessage?.status === 'failed') {
        await optionsRef.current.onRetryMessage(current.retryMessage)
        return
      }
      const lastUser = [...optionsRef.current.messages]
        .reverse()
        .find(message => message.role === 'user')
      if (lastUser?.content) {
        await optionsRef.current.onResumeSend(lastUser.content)
      }
    }
  }, [])

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
