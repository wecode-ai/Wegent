import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'
import { localConnectorAuthHealth } from '@/api/local/localConnectorAuth'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import { parseComposerReferences } from '@wegent/collaboration/composer/composerMentions'
import {
  enrichInstalledPluginsForLocalAuth,
  extractConnectorAuthConnectorSlug,
  extractConnectorAuthPluginKey,
  filterLocalRequirements,
  findFirstLocalNeedingLogin,
  findLocalConnectorsForMessage,
  installedPluginMatchesName,
  latestConnectorAuthMessage,
  listMentionedPluginReferences,
  listMentionedPluginNames,
  messageNeedsConnectorPreflight,
  resolveLocalConnectorAuthHint,
  toLocalConnectorAuthTarget,
  type LocalConnectorRequirement,
} from '@/features/plugins/localConnectorAuthGate'
import { isOpenAiOfficialMarketplaceId } from '@/features/plugins/marketplaceIdentity'
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

function hasOnlyOpenAiOfficialPluginMentions(input: string): boolean {
  const mentions = listMentionedPluginReferences(input)
  return (
    mentions.length > 0 && mentions.every(ref => isOpenAiOfficialMarketplaceId(ref.marketplaceName))
  )
}

function hasGithubCliMention(input: string): boolean {
  return (
    listMentionedPluginReferences(input).some(
      ref =>
        ref.pluginName.toLowerCase() === 'github' &&
        isOpenAiOfficialMarketplaceId(ref.marketplaceName)
    ) ||
    parseComposerReferences(input).some(
      ref =>
        ref.href === 'app://github' ||
        (ref.href.startsWith('app://') && ref.label.replace(/^[@$]/, '').toLowerCase() === 'github')
    )
  )
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
  const preflightVersionRef = useRef(0)
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const updatePending = useCallback((next: PendingConnectorAuth | null) => {
    // Consume synchronously so cancellation and repeated success callbacks
    // cannot send an obsolete draft before React commits the next render.
    pendingRef.current = next
    if (!next) preflightVersionRef.current += 1
    setPending(next)
  }, [])

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
      if (!messageNeedsConnectorPreflight(input) && !hasGithubCliMention(input)) {
        updatePending(null)
        return 'send'
      }
      if (pendingRef.current) return 'blocked'
      const version = ++preflightVersionRef.current
      try {
        const mentioned = listMentionedPluginNames(input)
        const githubCli = hasGithubCliMention(input)
        if (githubCli) {
          const health = await localConnectorAuthHealth(GITHUB_CLI_TARGET)
          if (version !== preflightVersionRef.current) return 'blocked'
          if (health.status !== 'ok') {
            updatePending({
              target: GITHUB_CLI_TARGET,
              title: t('workbench.github_cli_login_title'),
              mode: 'preflight',
              pendingInput: input,
            })
            return 'blocked'
          }
        }
        if (
          hasOnlyOpenAiOfficialPluginMentions(input) ||
          (githubCli && !messageNeedsConnectorPreflight(input))
        )
          return 'send'
        const pluginNames = mentioned
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
        if (version !== preflightVersionRef.current) return 'blocked'
        const requirements = findLocalConnectorsForMessage(input, plugins)
        if (requirements.length === 0) {
          return 'send'
        }
        const needing = await findFirstLocalNeedingLogin(requirements)
        if (version !== preflightVersionRef.current) return 'blocked'
        if (!needing) return 'send'
        updatePending({
          target: toLocalConnectorAuthTarget(needing),
          title: requirementTitle(needing, t),
          mode: 'preflight',
          pendingInput: input,
        })
        return 'blocked'
      } catch {
        if (version !== preflightVersionRef.current) return 'blocked'
        if (hasGithubCliMention(input)) {
          updatePending({
            target: GITHUB_CLI_TARGET,
            title: t('workbench.github_cli_login_title'),
            mode: 'preflight',
            pendingInput: input,
          })
          return 'blocked'
        }
        // If health gate fails unexpectedly, allow send and rely on mid-task resume.
        return 'send'
      }
    },
    [refreshPlugins, t, updatePending]
  )

  useEffect(() => {
    if (pending) return
    const candidate = latestConnectorAuthMessage(options.messages)
    if (!candidate) return
    const key = candidate.message.id
    if (handledResumeKeysRef.current.has(key)) return
    const version = preflightVersionRef.current

    void (async () => {
      try {
        const { message: latest, text } = candidate
        const pluginKey = extractConnectorAuthPluginKey(text)
        const connectorSlug = extractConnectorAuthConnectorSlug(text)
        if (pluginKey === 'github' && connectorSlug === GITHUB_CLI_TARGET.connectorSlug) {
          const health = await localConnectorAuthHealth(GITHUB_CLI_TARGET)
          if (
            version !== preflightVersionRef.current ||
            pendingRef.current ||
            handledResumeKeysRef.current.has(key)
          )
            return
          if (health.status !== 'ok') {
            handledResumeKeysRef.current.add(key)
            updatePending({
              target: GITHUB_CLI_TARGET,
              title: t('workbench.github_cli_login_title'),
              mode: 'resume',
              retryMessage: latest,
            })
          }
          return
        }
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
          updatePending({
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
          updatePending({
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
  }, [options.messages, pending, refreshPlugins, t, updatePending])

  const clearPending = useCallback(() => updatePending(null), [updatePending])

  const completePending = useCallback(async () => {
    const current = pendingRef.current
    updatePending(null)
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
  }, [updatePending])

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
