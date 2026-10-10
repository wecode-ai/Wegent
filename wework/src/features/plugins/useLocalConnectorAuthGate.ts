import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'
import { localConnectorAuthHealth } from '@/api/local/localConnectorAuth'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import { parseComposerReferences } from '@wegent/collaboration/composer/composerMentions'
import {
  extractConnectorAuthConnectorSlug,
  extractConnectorAuthPluginKey,
  filterLocalRequirements,
  findFirstLocalNeedingLogin,
  findLocalConnectorsForMessage,
  latestConnectorAuthMessage,
  listMentionedPluginReferences,
  listMentionedPluginNames,
  messageNeedsConnectorPreflight,
  resolveLocalConnectorAuthHint,
  toLocalConnectorAuthTarget,
  type LocalConnectorRequirement,
} from '@/features/plugins/localConnectorAuthGate'
import { isOpenAiOfficialMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { loadLocalConnectorAuthPlugins } from '@/features/plugins/prefetchLocalConnectorAuth'
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
  onError?: (message: string) => void
  active?: boolean
}) {
  const { t } = useTranslation('common')
  const active = options.active ?? true
  const [pending, setPending] = useState<PendingConnectorAuth | null>(null)
  const handledResumeKeysRef = useRef<Set<string>>(new Set())
  const pendingRef = useRef(pending)
  const preflightVersionRef = useRef(0)
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  useEffect(() => {
    return () => {
      preflightVersionRef.current += 1
      pendingRef.current = null
    }
  }, [])

  const updatePending = useCallback((next: PendingConnectorAuth | null) => {
    // Consume synchronously so cancellation and repeated success callbacks
    // cannot send an obsolete draft before React commits the next render.
    pendingRef.current = next
    if (!next) preflightVersionRef.current += 1
    setPending(next)
  }, [])

  const refreshPlugins = useCallback((pluginNames?: string[]) => {
    return loadLocalConnectorAuthPlugins(pluginNames ?? [])
  }, [])

  useEffect(() => {
    if (active) return
    preflightVersionRef.current += 1
    const current = pendingRef.current
    if (!current) return
    if (current.mode === 'resume' && current.retryMessage) {
      handledResumeKeysRef.current.delete(current.retryMessage.id)
    }
    updatePending(null)
  }, [active, updatePending])

  const gateBeforeSend = useCallback(
    async (input: string): Promise<'send' | 'blocked'> => {
      if (!active) return 'blocked'
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
          if (health.status === 'error') throw new Error('local_auth_health_failed')
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
        const plugins = await refreshPlugins(pluginNames)
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
        optionsRef.current.onError?.(t('workbench.plugins_local_auth_health_failed'))
        return 'blocked'
      }
    },
    [active, refreshPlugins, t, updatePending]
  )

  useEffect(() => {
    if (!active || pending) return
    const candidate = latestConnectorAuthMessage(options.messages)
    if (!candidate) return
    const key = candidate.message.id
    if (handledResumeKeysRef.current.has(key)) return
    const version = preflightVersionRef.current
    let cancelled = false
    const isCurrent = () =>
      !cancelled &&
      version === preflightVersionRef.current &&
      !pendingRef.current &&
      !handledResumeKeysRef.current.has(key)

    void (async () => {
      try {
        const { message: latest, text } = candidate
        const pluginKey = extractConnectorAuthPluginKey(text)
        const connectorSlug = extractConnectorAuthConnectorSlug(text)
        if (pluginKey === 'github' && connectorSlug === GITHUB_CLI_TARGET.connectorSlug) {
          const health = await localConnectorAuthHealth(GITHUB_CLI_TARGET)
          if (!isCurrent()) return
          if (health.status === 'error') throw new Error('local_auth_health_failed')
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
        const plugins = await refreshPlugins(pluginNames)
        const requirements = filterLocalRequirements(plugins, {
          pluginKey,
          connectorSlug,
        })
        // Only resume auth for a connector that still needs login. Do not fall
        // back to requirements[0] or an unrelated installed local connector.
        const needing = await findFirstLocalNeedingLogin(requirements)
        if (!isCurrent()) return
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
        if (!isCurrent()) return
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
        if (!isCurrent()) return
        handledResumeKeysRef.current.add(key)
        optionsRef.current.onError?.(t('workbench.plugins_local_auth_health_failed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, options.messages, pending, refreshPlugins, t, updatePending])

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
