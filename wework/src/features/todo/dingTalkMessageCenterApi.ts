import {
  subscribePersonalStandIn,
  type PersonalStandInSettings,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInInboxMessage, StandInInboxWork } from '@/api/standIn'
import type {
  MessageCenterRecord,
  MessageCenterScope,
  MessageCenterSnapshot,
  StandInMessageCenterApi,
} from '@/api/standInMessageCenter'
import { unavailableMessageCenterSnapshot } from './standInMessageCenterSource'

const DINGTALK_PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'
const DETAIL_CONCURRENCY = 4
const COMPONENT_UNAVAILABLE_CODES = new Set([
  'component_unavailable',
  'connection_cli_unavailable',
  'connection_cli_request_unavailable',
  'connection_cli_request_failed',
  'dependency_missing',
  'component_update_required',
  'component_update_failed',
])

type AccountScope = { profile: string; accountId: string; organizationId: string }
type Grant = Partial<AccountScope> & {
  version?: number
  authorized?: boolean
  paused?: boolean
  accountInvalidated?: boolean
}
type DelegationFields = {
  action?: MessageCenterRecord['decision']
  status?: 'complete' | 'submitting' | 'sent' | 'failed' | 'unknown'
  recordId?: string
  channelTaskId?: string
  receiptId?: string
  attemptId?: string
  submittedAt?: string
  finishedAt?: string
  reason?: string
  deliveryReason?: string
  reasonCode?: string
  takenOver?: boolean
  text?: string
  evidenceIds?: string[]
  evidence?: Array<{
    messageId?: string
    senderId?: string
    at?: string
    excerpt?: string
  }>
  policyVersion?: number
}
type ScopedSource = StandInSourceConnection &
  Partial<AccountScope> & {
    kind: 'direct' | 'group'
    delegated?: boolean
    paused?: boolean
  }
type NativeWork = StandInInboxWork & {
  delegationResult?: DelegationFields
  takenOverAt?: string
}
type NativeMessage = Omit<StandInInboxMessage, 'delegationResult'> & {
  delegationResult?: DelegationFields
  takenOverAt?: string
}
type NativeApi = Pick<StandInExecutorApi, 'personalGet' | 'inbox' | 'workMessages'> & {
  personalSave?: StandInExecutorApi['personalSave']
  connectionReadiness?(
    deviceId: string,
    providerId: string,
    profile: string
  ): Promise<{
    status: string
    code?: string
    identity?: AccountScope & { accountName: string; organizationName: string }
  }>
  takeOverWork?(userId: number, deviceId: string, workId: string): Promise<void>
  verifyWorkDelivery?(
    userId: number,
    deviceId: string,
    workId: string,
    recordId: string
  ): Promise<void>
}

function hostGrant(settings: PersonalStandInSettings) {
  // The public StandIn types predate the delegation fields on the Executor wire.
  return (settings.primary as PersonalStandInSettings['primary'] & { delegation?: Grant })
    ?.delegation
}

function hasAccount(grant: Grant | undefined): grant is Grant & AccountScope {
  return (
    !!grant &&
    !grant.accountInvalidated &&
    [grant.profile, grant.accountId, grant.organizationId].every(
      value => typeof value === 'string' && Boolean(value.trim())
    )
  )
}

function sameAccount(candidate: Partial<AccountScope> | undefined, account: AccountScope) {
  return (
    candidate?.profile === account.profile &&
    candidate.accountId === account.accountId &&
    candidate.organizationId === account.organizationId
  )
}

function accountKey(account: AccountScope) {
  return JSON.stringify([account.profile, account.accountId, account.organizationId])
}

function ownedBy(settings: PersonalStandInSettings, scope: MessageCenterScope) {
  return settings.userId === scope.userId && settings.executionDeviceId === scope.deviceId
}

function isScopedSource(
  source: StandInSourceConnection,
  account: AccountScope
): source is ScopedSource {
  return (
    source.providerId === DINGTALK_PROVIDER &&
    (source.kind === 'direct' || source.kind === 'group') &&
    !!source.id &&
    source.id !== '*' &&
    !source.scope &&
    !source.collectionKey &&
    sameAccount(source, account)
  )
}

function delegationAction(settings: PersonalStandInSettings, grant: Grant & AccountScope) {
  const { primary, lifecycle } = settings
  if (!grant.authorized || version(grant.version) === undefined || !primary?.enabled || lifecycle) {
    return
  }
  if (grant.paused === false) return 'pause'
  if (
    grant.paused === true &&
    primary.model?.runtime === 'codex' &&
    primary.connections?.some(
      source => isScopedSource(source, grant) && source.delegated && !source.paused
    )
  ) {
    return 'resume'
  }
}

function sourceKey(source: StandInSourceConnection) {
  return JSON.stringify([source.kind, source.id])
}

function timestamp(value?: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined
}

function version(value?: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function projectedDelivery(result?: DelegationFields): MessageCenterRecord['delivery'] {
  if (result?.status === 'failed') return 'failed'
  if (result?.action !== 'reply') return 'none'
  switch (result.status) {
    case 'sent':
      return result.receiptId?.trim() && result.text?.trim() ? 'confirmed' : 'unknown'
    case 'submitting':
      return 'submitted'
    default:
      return 'unknown'
  }
}

function resultForMessage(work: NativeWork, message: NativeMessage) {
  if (message.delegationResult?.action) return message.delegationResult
  const projected = work.delegationResult
  if (projected && (!projected.recordId || projected.recordId === message.recordId))
    return projected
}

function evidenceExcerpt(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized
}

function projectEvidence(
  ids: string[] | undefined,
  messages: NativeMessage[],
  persisted: DelegationFields['evidence']
) {
  if (!ids?.length) return undefined
  const byId = new Map<string, NativeMessage>()
  for (const message of messages) {
    byId.set(message.id, message)
    byId.set(message.recordId, message)
  }
  return ids.map(id => {
    const saved = persisted?.find(evidence => evidence.messageId === id)
    const source = byId.get(id)
    if (saved) {
      return {
        label: [saved.senderId, saved.at].filter(Boolean).join(' · ') || id,
        excerpt: saved.excerpt?.trim() || undefined,
      }
    }
    if (!source) return { label: id }
    return {
      label: [source.senderId, source.at].filter(Boolean).join(' · '),
      excerpt: evidenceExcerpt(source.text),
    }
  })
}

function projectRecord(
  work: NativeWork,
  message: NativeMessage,
  result: DelegationFields | undefined,
  messages: NativeMessage[],
  deviceName: string,
  api: NativeApi
): MessageCenterRecord {
  const failedWork = work.status === 'failed' && !result
  const delivery = failedWork ? 'failed' : projectedDelivery(result)
  const takenOver = Boolean(work.takenOverAt || message.takenOverAt || result?.takenOver)
  const finishedAt = timestamp(result?.finishedAt)
  const submittedAt = timestamp(result?.submittedAt)
  const reason =
    [result?.reason ?? (!result ? work.error : undefined), result?.deliveryReason]
      .filter(Boolean)
      .join('\n\n') || undefined
  const attempts: NonNullable<MessageCenterRecord['attempts']> = []
  if (result?.attemptId && submittedAt) attempts.push({ at: submittedAt, status: 'submitted' })
  if (result?.attemptId && finishedAt && delivery !== 'none' && delivery !== 'submitted') {
    attempts.push({ at: finishedAt, status: delivery, reason: result.deliveryReason })
  }
  return {
    id: message.recordId,
    title: work.title,
    sourceId: sourceKey(message.source),
    sourceName: message.source.name,
    sender: message.senderId,
    message: message.text,
    at: message.at,
    decision: result?.action ?? null,
    progress:
      failedWork || result ? (delivery === 'submitted' ? 'submitting' : 'complete') : 'queued',
    delivery,
    ...(delivery === 'confirmed' && result?.receiptId
      ? {
          receipt: { id: result.receiptId.trim(), verifiedAt: finishedAt, kind: 'channel_receipt' },
        }
      : {}),
    reply: result?.text,
    reason,
    evidence: projectEvidence(result?.evidenceIds, messages, result?.evidence),
    attempts,
    takenOver,
    canTakeOver: Boolean(
      api.takeOverWork && !takenOver && result?.action !== 'skip' && delivery !== 'confirmed'
    ),
    canVerify: Boolean(
      api.verifyWorkDelivery && result?.status === 'unknown' && result.channelTaskId?.trim()
    ),
    policyVersion: version(result?.policyVersion),
    deviceName,
  }
}

function messageBelongsToWork(message: NativeMessage, work: NativeWork, account: AccountScope) {
  return (
    isScopedSource(message.source, account) &&
    message.source.delegated === true &&
    sourceKey(message.source) === sourceKey(work.source)
  )
}

async function readWorkMessages(
  api: NativeApi,
  scope: MessageCenterScope,
  work: NativeWork,
  account: AccountScope
) {
  const latest = work.latestMessage as NativeMessage | undefined
  const projectedRecordId = work.delegationResult?.recordId
  const messages =
    latest &&
    work.messageCount <= 1 &&
    (!projectedRecordId || projectedRecordId === latest.recordId)
      ? [latest]
      : ((await api.workMessages(scope.userId, scope.deviceId, work.id))
          .messages as NativeMessage[])
  return messages.filter(message => messageBelongsToWork(message, work, account))
}

function currentWork(items: NativeWork[], account: AccountScope) {
  return items.filter(
    work =>
      work.roleId === '@primary' &&
      isScopedSource(work.source, account) &&
      work.source.delegated === true
  )
}

async function readRecords(
  api: NativeApi,
  scope: MessageCenterScope,
  items: NativeWork[],
  account: AccountScope,
  deviceName: string
) {
  const records: MessageCenterRecord[] = []
  const seen = new Set<string>()
  let detailFailures = 0
  for (let start = 0; start < items.length; start += DETAIL_CONCURRENCY) {
    const rows = await Promise.allSettled(
      items.slice(start, start + DETAIL_CONCURRENCY).map(async work => {
        const messages = await readWorkMessages(api, scope, work, account)
        const withResults = messages.filter(message => resultForMessage(work, message))
        const pending = messages
          .filter(message => !resultForMessage(work, message))
          .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0]
        const projected = [...withResults, ...(pending ? [pending] : [])]
        return projected.map(message =>
          projectRecord(work, message, resultForMessage(work, message), messages, deviceName, api)
        )
      })
    )
    for (const row of rows) {
      if (row.status === 'rejected') {
        detailFailures += 1
        continue
      }
      for (const record of row.value) {
        if (seen.has(record.id)) continue
        seen.add(record.id)
        records.push(record)
      }
    }
  }
  return { records, detailFailures }
}

async function findWorkRecord(
  api: NativeApi,
  scope: MessageCenterScope,
  items: NativeWork[],
  account: AccountScope,
  recordId: string
) {
  const ordered = [...items].sort((left, right) => {
    const score = (work: NativeWork) =>
      Number(work.delegationResult?.recordId === recordId) * 2 +
      Number(work.latestMessage?.recordId === recordId)
    return score(right) - score(left)
  })
  for (const work of ordered) {
    try {
      const messages = await readWorkMessages(api, scope, work, account)
      const message = messages.find(row => row.recordId === recordId)
      if (message) return { work, message, messages }
    } catch {
      // A damaged work detail must not hide the exact record in another work.
    }
  }
}

export function createDingTalkMessageCenterApi(
  api: NativeApi,
  { deviceName = '' }: { deviceName?: string } = {}
): StandInMessageCenterApi {
  const empty = (status: MessageCenterSnapshot['status']): MessageCenterSnapshot => ({
    ...unavailableMessageCenterSnapshot,
    deviceName,
    status,
    capabilities: ['refresh'],
  })

  const readContext = async (scope: MessageCenterScope) => {
    const settings = await api.personalGet(scope.userId, scope.deviceId)
    const grant = hostGrant(settings)
    if (!ownedBy(settings, scope) || !api.connectionReadiness) {
      return { snapshot: empty('unavailable') }
    }
    if (!hasAccount(grant)) return { snapshot: empty('disconnected') }
    const readiness = await api.connectionReadiness(
      scope.deviceId,
      DINGTALK_PROVIDER,
      grant.profile
    )
    if (
      readiness.status === 'component_unavailable' ||
      (readiness.code && COMPONENT_UNAVAILABLE_CODES.has(readiness.code))
    ) {
      return { snapshot: empty('component_unavailable') }
    }
    if (readiness.status !== 'ready') {
      const disconnected =
        readiness.status === 'auth_required' || readiness.status === 'identity_required'
      return { snapshot: empty(disconnected ? 'disconnected' : 'unavailable') }
    }
    if (!readiness.identity || !sameAccount(readiness.identity, grant)) {
      return { snapshot: empty('disconnected') }
    }
    const identity = {
      id: accountKey(grant),
      account: readiness.identity.accountName,
      organization: readiness.identity.organizationName,
    }
    return { settings, grant, identity }
  }

  const unchanged = async (
    scope: MessageCenterScope,
    settings: PersonalStandInSettings,
    grant: Grant & AccountScope
  ) => {
    const current = await api.personalGet(scope.userId, scope.deviceId)
    const currentGrant = hostGrant(current)
    return (
      ownedBy(current, scope) &&
      current.version === settings.version &&
      hasAccount(currentGrant) &&
      sameAccount(currentGrant, grant) &&
      currentGrant.version === grant.version
    )
  }

  const read: StandInMessageCenterApi['read'] = async scope => {
    const context = await readContext(scope)
    if (context.snapshot) return context.snapshot
    const { settings, grant, identity } = context
    const inbox = await api.inbox(scope.userId, scope.deviceId)
    const items = currentWork(inbox.items, grant)
    const { records, detailFailures } = await readRecords(api, scope, items, grant, deviceName)
    if (!(await unchanged(scope, settings, grant))) return empty('unavailable')
    const policyVersion = version(grant.version) ?? null
    const capabilities: Array<MessageCenterSnapshot['capabilities'][number]> = ['refresh']
    const action = api.personalSave && delegationAction(settings, grant)
    if (action) capabilities.push(action)
    if (policyVersion !== null && api.takeOverWork) capabilities.push('takeOver')
    if (policyVersion !== null && api.verifyWorkDelivery) capabilities.push('verifyDelivery')
    const errors = inbox.sourceErrors.filter(row => isScopedSource(row.source, grant))
    const syncGap = [
      ...errors
        .filter(row => row.error.code === 'dingtalk_delegation_gap')
        .map(row => row.error.message),
      ...(detailFailures
        ? [
            `${detailFailures} DingTalk work detail${detailFailures === 1 ? '' : 's'} could not be synchronized.`,
          ]
        : []),
    ].join('\n')
    const updatedAt = items.reduce<string | null>((latest, item) => {
      const at = timestamp(item.updatedAt)
      return at && (!latest || Date.parse(at) > Date.parse(latest)) ? at : latest
    }, null)
    const status =
      !grant.authorized || !settings.primary?.enabled || settings.lifecycle
        ? 'disabled'
        : grant.paused
          ? 'paused'
          : errors.some(row => row.error.code !== 'dingtalk_delegation_gap')
            ? 'unavailable'
            : settings.primary.model?.runtime === 'codex'
              ? 'active'
              : 'model_unavailable'
    return {
      identity,
      deviceName,
      updatedAt,
      status,
      records,
      sources: (settings.primary?.connections ?? [])
        .filter((source): source is ScopedSource => isScopedSource(source, grant))
        .map(source => ({
          id: sourceKey(source),
          conversationId: source.id,
          name: source.name,
          kind: source.kind,
          included: true,
          paused: source.paused === true,
        })),
      policyVersion,
      ...(syncGap ? { syncGap } : {}),
      capabilities,
    }
  }

  return {
    read,
    async apply(scope, expected, command) {
      const context = await readContext(scope)
      if (
        context.snapshot ||
        context.identity.id !== expected.identityId ||
        context.grant.version !== expected.policyVersion
      ) {
        throw new Error('DingTalk account or delegation changed')
      }
      const { settings, grant } = context
      if (command.type === 'pause' || command.type === 'resume') {
        const { primary } = settings
        if (
          !api.personalSave ||
          !primary ||
          delegationAction(settings, grant) !== command.type ||
          !(await unchanged(scope, settings, grant))
        ) {
          throw new Error('DingTalk delegation is no longer available for this action')
        }
        const draft = {
          ...settings,
          primary: { ...primary, delegation: { ...grant, action: command.type } },
        }
        // The versioned save verifies the current account, sources and model before resuming.
        const saved = await api.personalSave(scope.userId, draft, scope.deviceId)
        const savedGrant = hostGrant(saved)
        if (
          !ownedBy(saved, scope) ||
          !hasAccount(savedGrant) ||
          !sameAccount(savedGrant, grant) ||
          !savedGrant.authorized ||
          savedGrant.paused !== (command.type === 'pause')
        ) {
          throw new Error('The DingTalk delegation change was not saved')
        }
        return read(scope)
      }
      const inbox = await api.inbox(scope.userId, scope.deviceId)
      const target = await findWorkRecord(
        api,
        scope,
        currentWork(inbox.items, grant),
        grant,
        command.recordId
      )
      if (!target || !(await unchanged(scope, settings, grant))) {
        throw new Error('DingTalk message is no longer available for this action')
      }
      const { work, message, messages } = target
      const record = projectRecord(
        work,
        message,
        resultForMessage(work, message),
        messages,
        deviceName,
        api
      )
      if (command.type === 'takeOver' && record.canTakeOver && api.takeOverWork) {
        await api.takeOverWork(scope.userId, scope.deviceId, work.id)
      } else if (command.type === 'verifyDelivery' && record.canVerify && api.verifyWorkDelivery) {
        await api.verifyWorkDelivery(scope.userId, scope.deviceId, work.id, message.recordId)
      } else {
        throw new Error('This action is unavailable for the DingTalk message')
      }
      return read(scope)
    },
    subscribeInvalidation(scope, onInvalidate) {
      return subscribePersonalStandIn(settings => {
        if (!ownedBy(settings, scope)) return
        const grant = hostGrant(settings)
        onInvalidate('identity', hasAccount(grant) ? accountKey(grant) : undefined)
      })
    },
  }
}
