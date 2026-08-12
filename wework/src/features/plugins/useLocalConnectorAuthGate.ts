import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'
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
  installedPluginMatchesName,
  listMentionedPluginNames,
  messageNeedsConnectorPreflight,
  messageRequiresConnectorAuth,
  resolveLocalConnectorAuthHint,
  toLocalConnectorAuthTarget,
  type LocalConnectorRequirement,
} from '@/features/plugins/localConnectorAuthGate'
import { peekWarmedLocalConnectorAuthPlugins } from '@/features/plugins/prefetchLocalConnectorAuth'
import type { InstalledPlugin } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

export interface PendingConnectorAuth {
  target: LocalConnectorAuthTarget
  title: string
  mode: 'preflight' | 'resume'
  pendingInput?: string
  retryMessage?: WorkbenchMessage
}

function requirementTitle(
  requirement: LocalConnectorRequirement,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return requirement.localAuth.kind === 'browser_oauth'
    ? t('workbench.plugins_local_browser_login_title', { name: requirement.displayName })
    : t('workbench.plugins_local_qr_login_title', { name: requirement.displayName })
}

function hintTitle(
  displayName: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return t('workbench.plugins_local_qr_login_title', { name: displayName })
}

async function loadInstalledPlugins(options?: {
  pluginNames?: string[]
}): Promise<InstalledPlugin[]> {
  const api = createLocalCodexPluginApi()
  const response = await api.listInstalledPlugins()
  const items = response.items ?? []
  const pluginNames = options?.pluginNames ?? []
  // Only detail plugins we might need for this message. Full-catalog enrich used to
  // call readInstalledPluginForTrial → readState/plugin/list and stalled send by ~10s.
  return enrichInstalledPluginsForLocalAuth(
    items,
    plugin => api.readInstalledPluginDetail(plugin),
    {
      shouldEnrich:
        pluginNames.length > 0
          ? plugin => pluginNames.some(name => installedPluginMatchesName(plugin, name))
          : () => false,
    }
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
  const { t } = useTranslation('common')
  const [pending, setPending] = useState<PendingConnectorAuth | null>(null)
  const pluginsRef = useRef<InstalledPlugin[] | null>(null)
  const enrichedPluginNamesRef = useRef(new Set<string>())
  const handledResumeKeysRef = useRef<Set<string>>(new Set())
  const pendingRef = useRef(pending)
  const optionsRef = useRef(options)

  useEffect(() => {
    pendingRef.current = pending
    optionsRef.current = options
  }, [options, pending])

  const refreshPlugins = useCallback(async (pluginNames?: string[]) => {
    const names = pluginNames ?? []
    const plugins = await loadInstalledPlugins({ pluginNames: names })
    // Merge with prior enriched detail. A later refresh for plugin B must not
    // wipe connector/localAuth stubs already loaded for plugin A.
    const previousByKey = new Map(
      (pluginsRef.current ?? []).map(plugin => [
        `${plugin.spec.source.marketplace || plugin.metadata.namespace || ''}:${plugin.spec.source.pluginKey}`.toLowerCase(),
        plugin,
      ])
    )
    const merged = plugins.map(plugin => {
      const key =
        `${plugin.spec.source.marketplace || plugin.metadata.namespace || ''}:${plugin.spec.source.pluginKey}`.toLowerCase()
      if (names.some(name => installedPluginMatchesName(plugin, name))) return plugin
      return previousByKey.get(key) ?? plugin
    })
    pluginsRef.current = merged
    for (const name of names) {
      enrichedPluginNamesRef.current.add(name.trim().toLowerCase())
    }
    return merged
  }, [])

  const gateBeforeSend = useCallback(
    async (input: string): Promise<'send' | 'blocked'> => {
      if (pendingRef.current) return 'blocked'
      if (!messageNeedsConnectorPreflight(input)) return 'send'
      try {
        const mentioned = listMentionedPluginNames(input)
        const hint = resolveLocalConnectorAuthHint(input)
        const pluginNames = [...mentioned, ...(hint?.pluginKey ? [hint.pluginKey] : [])]
        const cached = pluginsRef.current
        const cachedCoversMentions =
          Boolean(cached) &&
          pluginNames.length > 0 &&
          pluginNames.every(name => {
            const key = name.trim().toLowerCase()
            return (
              enrichedPluginNamesRef.current.has(key) &&
              cached!.some(plugin => installedPluginMatchesName(plugin, name))
            )
          })
        let plugins = cachedCoversMentions ? cached! : null
        if (!plugins) {
          const warmed = peekWarmedLocalConnectorAuthPlugins(pluginNames)
          if (warmed) {
            const previousByKey = new Map(
              (pluginsRef.current ?? []).map(plugin => [
                `${plugin.spec.source.marketplace || plugin.metadata.namespace || ''}:${plugin.spec.source.pluginKey}`.toLowerCase(),
                plugin,
              ])
            )
            pluginsRef.current = warmed.map(plugin => {
              const key =
                `${plugin.spec.source.marketplace || plugin.metadata.namespace || ''}:${plugin.spec.source.pluginKey}`.toLowerCase()
              if (pluginNames.some(name => installedPluginMatchesName(plugin, name))) return plugin
              return previousByKey.get(key) ?? plugin
            })
            for (const name of pluginNames) {
              enrichedPluginNamesRef.current.add(name.trim().toLowerCase())
            }
            plugins = pluginsRef.current
          } else {
            plugins = await refreshPlugins(pluginNames.length > 0 ? pluginNames : undefined)
          }
        }
        const requirements = findLocalConnectorsForMessage(input, plugins)
        if (requirements.length === 0) {
          if (!hint) return 'send'
          const target: LocalConnectorAuthTarget = {
            pluginKey: hint.pluginKey,
            connectorSlug: hint.connectorSlug,
          }
          if (!(await targetNeedsLogin(target))) return 'send'
          setPending({
            target,
            title: hintTitle(hint.displayName, t),
            mode: 'preflight',
            pendingInput: input,
          })
          return 'blocked'
        }
        const needing = await findFirstLocalNeedingLogin(requirements)
        if (!needing) return 'send'
        setPending({
          target: toLocalConnectorAuthTarget(needing),
          title: requirementTitle(needing, t),
          mode: 'preflight',
          pendingInput: input,
        })
        return 'blocked'
      } catch {
        // If health gate fails unexpectedly, allow send and rely on mid-task resume.
        return 'send'
      }
    },
    [refreshPlugins, t]
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
        const pluginKey = extractConnectorAuthPluginKey(text)
        const connectorSlug = extractConnectorAuthConnectorSlug(text)
        const hint = resolveLocalConnectorAuthHint(text)
        const pluginNames = [
          ...(pluginKey ? [pluginKey] : []),
          ...(hint?.pluginKey ? [hint.pluginKey] : []),
        ]
        const resumeCovered =
          Boolean(pluginsRef.current) &&
          pluginNames.length > 0 &&
          pluginNames.every(name => enrichedPluginNamesRef.current.has(name.trim().toLowerCase()))
        const plugins = resumeCovered
          ? pluginsRef.current!
          : await refreshPlugins(pluginNames.length > 0 ? pluginNames : undefined)
        const requirements = filterLocalRequirements(plugins, {
          pluginKey,
          connectorSlug,
        })
        // Only resume auth for a connector that still needs login. Do not fall
        // back to requirements[0] or an unrelated installed local connector.
        const needing = await findFirstLocalNeedingLogin(requirements)
        if (needing) {
          handledResumeKeysRef.current.add(key)
          setPending({
            target: toLocalConnectorAuthTarget(needing),
            title: requirementTitle(needing, t),
            mode: 'resume',
            retryMessage: latest,
          })
          return
        }

        if (!hint) return
        const hintedRequirements = filterLocalRequirements(plugins, {
          pluginKey: hint.pluginKey,
          connectorSlug: hint.connectorSlug,
        })
        const hintedNeeding = await findFirstLocalNeedingLogin(hintedRequirements)
        if (hintedNeeding) {
          handledResumeKeysRef.current.add(key)
          setPending({
            target: toLocalConnectorAuthTarget(hintedNeeding),
            title: requirementTitle(hintedNeeding, t),
            mode: 'resume',
            retryMessage: latest,
          })
          return
        }
        // No installed local connector matched. Do not invent a QR/browser card
        // for cloud-only connector failures (e.g. GitHub MCP search anomalies).
      } catch {
        // ignore detection failures; leave unhandled so a later refresh can retry
      }
    })()
  }, [options.messages, pending, refreshPlugins, t])

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
