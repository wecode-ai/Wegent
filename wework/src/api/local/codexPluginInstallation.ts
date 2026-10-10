import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import i18n from '@/i18n'

interface CodexInstallationReceipt {
  awaitingMembership: boolean
  acceptedAt: number
  authPolicy: 'ON_INSTALL' | 'ON_USE'
  appsNeedingAuth: Array<{ id: string; name: string }>
}

/** Bound discovery races without indefinitely overriding native membership. */
export const CODEX_INSTALLATION_RECEIPT_TTL_MS = 5 * 60 * 1000

function decodeInstallationReceipt(value: unknown): CodexInstallationReceipt {
  const response = value as Partial<CodexInstallationReceipt> | null
  if (
    !response ||
    !['ON_INSTALL', 'ON_USE'].includes(response.authPolicy ?? '') ||
    !Array.isArray(response.appsNeedingAuth) ||
    response.appsNeedingAuth.some(
      app => !app || typeof app.id !== 'string' || typeof app.name !== 'string'
    )
  ) {
    throw new Error('Invalid Codex plugin/install response')
  }
  return {
    awaitingMembership: true,
    acceptedAt: Date.now(),
    authPolicy: response.authPolicy as CodexInstallationReceipt['authPolicy'],
    // Installation never proves account authorization. Do not persist auth URLs.
    appsNeedingAuth: response.appsNeedingAuth.map(({ id, name }) => ({ id, name })),
  }
}

/** The successful mutation, not a lagging discovery read, confirms installation. */
export function remotePluginInstallation(
  item: PluginMarketplaceItem,
  result: unknown
): InstalledPlugin {
  const receipt = decodeInstallationReceipt(result)
  const marketplace = String(item.manifest.marketplaceId)
  const id =
    typeof item.manifest.id === 'string' && item.manifest.id.trim()
      ? item.manifest.id.trim()
      : `${item.name}@${marketplace}`
  const installed = toInstalledPlugin(
    { name: marketplace, path: null, plugins: [] },
    {
      id,
      name: item.name,
      remotePluginId: item.remotePluginId,
      installed: true,
      enabled: true,
      localVersion: item.version,
      interface: item.interface,
      authPolicy: receipt.authPolicy,
      source: item.manifest.source as Record<string, unknown> | undefined,
    },
    undefined,
    key => i18n.t(key)
  )
  return {
    ...installed,
    spec: {
      ...installed.spec,
      displayName: item.displayName,
      description: item.description,
      author: item.author,
      components: item.components,
      manifest: { ...item.manifest, id, authPolicy: receipt.authPolicy },
      sourcePayload: { ...installed.spec.sourcePayload, codexInstallationReceipt: receipt },
    },
  }
}

function receiptOf(plugin: InstalledPlugin): CodexInstallationReceipt | undefined {
  return plugin.spec.sourcePayload?.codexInstallationReceipt as CodexInstallationReceipt | undefined
}

function identity(plugin: InstalledPlugin): string {
  return JSON.stringify([
    plugin.spec.source.marketplace || plugin.spec.source.providerKey,
    plugin.spec.source.pluginKey,
  ])
}

/** Reconcile accepted writes inside the canonical inventory, without a second cache. */
export function reconcileCodexInstallations(
  previous: InstalledPlugin[],
  incoming: InstalledPlugin[]
): InstalledPlugin[] {
  const now = Date.now()
  const pending = previous.filter(plugin => {
    const receipt = receiptOf(plugin)
    // Legacy receipts have no acceptance time and cannot establish current membership.
    return (
      receipt?.awaitingMembership === true &&
      Number.isFinite(receipt.acceptedAt) &&
      receipt.acceptedAt <= now &&
      now - receipt.acceptedAt < CODEX_INSTALLATION_RECEIPT_TTL_MS
    )
  })
  if (!pending.length) return incoming
  const byIdentity = new Map(incoming.map(plugin => [identity(plugin), plugin]))
  for (const installed of pending) {
    const key = identity(installed)
    const observed = byIdentity.get(key)
    if (!observed) {
      byIdentity.set(key, installed)
    } else if (!receiptOf(observed)?.awaitingMembership) {
      byIdentity.set(key, {
        ...observed,
        spec: {
          ...observed.spec,
          sourcePayload: {
            ...observed.spec.sourcePayload,
            codexInstallationReceipt: { ...receiptOf(installed), awaitingMembership: false },
          },
        },
      })
    }
  }
  return [...byIdentity.values()]
}
