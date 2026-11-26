import {
  STAND_IN_DINGTALK_PROVIDER,
  type StandInDingTalkDelegation,
  type StandInIdentity,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInDelegationResult } from '@/api/standIn'

export const delegationTemplates = ['document', 'schedule', 'process'] as const

export const defaultDingTalkDelegation: StandInDingTalkDelegation = {
  version: 0,
  paused: false,
  templates: { document: true, schedule: true, process: true },
}

export const isDingTalkSource = (source: Pick<StandInSourceConnection, 'providerId'>) =>
  source.providerId === STAND_IN_DINGTALK_PROVIDER

export function dingTalkInboxScope(delegation?: StandInDingTalkDelegation) {
  if (!delegation?.accountId) return undefined
  return JSON.stringify([
    delegation.profile,
    delegation.accountId,
    delegation.organizationId,
    delegation.accountInvalidated,
    delegation.version,
  ])
}

type SourceIdentity = Pick<
  StandInSourceConnection,
  'providerId' | 'id' | 'kind' | 'profile' | 'accountId' | 'scope' | 'collectionKey'
>

export function isDingTalkDelegationSource(source: SourceIdentity) {
  return (
    isDingTalkSource(source) &&
    !!source.profile &&
    !!source.accountId &&
    !!source.id &&
    source.id !== '*' &&
    (source.kind === 'direct' || source.kind === 'group') &&
    !source.scope &&
    !source.collectionKey
  )
}

function sourceKey(source: SourceIdentity) {
  return JSON.stringify([
    source.profile,
    source.accountId,
    source.kind,
    source.id,
    source.scope,
    source.collectionKey,
  ])
}

export function matchesDingTalkAccount(
  account: { profile?: string; accountId?: string } | undefined,
  source: { profile?: string; accountId?: string }
) {
  return Boolean(
    account?.profile &&
    account.accountId &&
    account.profile === source.profile &&
    account.accountId === source.accountId
  )
}

export function dingTalkDelegationModel(
  saved: StandInIdentity,
  draft: StandInIdentity,
  account?: ConnectionProviderDescriptor['availability']
) {
  const original = saved.delegation ?? defaultDingTalkDelegation
  const delegation = draft.delegation ?? defaultDingTalkDelegation
  const savedSources = saved.connections ?? []
  const sources = draft.connections ?? []
  const binding = account?.accountId ? account : original
  const savedGrant = original.authorized === true && !original.accountInvalidated
  const authorized = savedGrant && matchesDingTalkAccount(binding, original)
  const selected = sources.filter(
    row => isDingTalkDelegationSource(row) && matchesDingTalkAccount(binding, row)
  )
  const enabledSources = selected.filter(row => !row.paused)
  const before = new Set(
    savedSources.filter(row => isDingTalkDelegationSource(row) && !row.paused).map(sourceKey)
  )
  const after = new Set(enabledSources.map(sourceKey))
  const sourceChanged = sources.some(row => isDingTalkSource(row) && !selected.includes(row))
  const otherSources = sources.filter(row => !isDingTalkSource(row))
  const accountChanged = sources.some(
    row => isDingTalkDelegationSource(row) && !matchesDingTalkAccount(original, row)
  )
  return {
    delegation,
    authorized,
    selected,
    canEnable: account?.status === 'ready' && enabledSources.length > 0,
    reconfirm: original.accountInvalidated === true || sourceChanged || (savedGrant && !authorized),
    narrows:
      authorized &&
      ([...before].some(key => !after.has(key)) ||
        delegationTemplates.some(key => original.templates[key] && !delegation.templates[key])),
    widens:
      authorized &&
      ([...after].some(key => !before.has(key)) ||
        delegationTemplates.some(key => !original.templates[key] && delegation.templates[key])),
    submission(enable = false): StandInIdentity {
      if (!enable && (!savedGrant || accountChanged)) {
        // Keep the saved policy for any retained legacy scope until explicit enablement.
        const draftScopes = new Set(sources.filter(isDingTalkSource).map(sourceKey))
        return {
          ...draft,
          delegation: saved.delegation,
          connections: [
            ...otherSources,
            ...savedSources.filter(
              row => isDingTalkSource(row) && (savedGrant || draftScopes.has(sourceKey(row)))
            ),
          ],
        }
      }
      const authorizedSources = enable
        ? selected
        : sources.filter(
            row => isDingTalkDelegationSource(row) && matchesDingTalkAccount(original, row)
          )
      return {
        ...draft,
        enabled: enable || draft.enabled,
        delegation: { ...delegation, ...(enable && { action: 'enable' as const }) },
        connections: [
          ...otherSources,
          ...authorizedSources.map(row => ({
            ...row,
            policy: { ...row.policy, automatic: true, askBeforeAct: false, immediate: true },
          })),
        ],
      }
    },
  }
}

export function delegationResultLabel(result?: StandInDelegationResult) {
  if (result?.action === 'needs_user') return 'standIn.dingtalk_delegation.result_needs_user'
  if (result?.action !== 'reply') return undefined
  if (result.status === 'sent') return 'standIn.dingtalk_delegation.result_sent'
  if (result.status === 'submitting') return 'standIn.dingtalk_delegation.result_submitting'
  return 'standIn.dingtalk_delegation.result_unknown'
}
