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
  takenOver?: boolean
  text?: string
  evidenceIds?: string[]
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
type NativeApi = Pick<StandInExecutorApi, 'personalGet' | 'inbox' | 'workMessages'> & {
  connectionReadiness?(
    deviceId: string,
    providerId: string,
    profile: string
  ): Promise<{
    status: string
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
  if (result?.action !== 'reply') return 'none'
  switch (result.status) {
    case 'sent':
      return result.receiptId?.trim() && result.text?.trim() ? 'confirmed' : 'unknown'
    case 'submitting':
      return 'submitted'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

function projectRecord(
  work: NativeWork,
  message: StandInInboxMessage,
  deviceName: string,
  api: NativeApi
): MessageCenterRecord {
  const result = work.delegationResult
  const delivery = projectedDelivery(result)
  const takenOver = Boolean(work.takenOverAt || result?.takenOver)
  const finishedAt = timestamp(result?.finishedAt)
  const submittedAt = timestamp(result?.submittedAt)
  const reason =
    [result?.reason ?? work.error, result?.deliveryReason].filter(Boolean).join('\n\n') || undefined
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
    progress: result ? (delivery === 'submitted' ? 'submitting' : 'complete') : 'queued',
    delivery,
    ...(delivery === 'confirmed' && result?.receiptId
      ? {
          receipt: { id: result.receiptId.trim(), verifiedAt: finishedAt, kind: 'channel_receipt' },
        }
      : {}),
    reply: result?.text,
    reason,
    evidence: result?.evidenceIds?.map(id => ({ label: id })),
    attempts,
    takenOver,
    canTakeOver: Boolean(
      api.takeOverWork &&
      work.messageCount === 1 &&
      !takenOver &&
      result?.action !== 'skip' &&
      delivery !== 'confirmed'
    ),
    canVerify: Boolean(
      api.verifyWorkDelivery && result?.status === 'unknown' && result.channelTaskId?.trim()
    ),
    policyVersion: version(result?.policyVersion),
    deviceName,
  }
}

function workRecordId(work: NativeWork) {
  const result = work.delegationResult
  return (
    result?.recordId ??
    (!result || work.messageCount === 1 ? work.latestMessage?.recordId : undefined)
  )
}

async function readWorkMessage(
  api: NativeApi,
  scope: MessageCenterScope,
  work: NativeWork,
  account: AccountScope
) {
  const recordId = workRecordId(work)
  if (!recordId) return undefined
  const { latestMessage } = work
  const message =
    latestMessage?.recordId === recordId
      ? latestMessage
      : (await api.workMessages(scope.userId, scope.deviceId, work.id)).messages.find(
          row => row.recordId === recordId
        )
  if (
    message &&
    isScopedSource(message.source, account) &&
    message.source.delegated === true &&
    sourceKey(message.source) === sourceKey(work.source)
  ) {
    return message
  }
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
  // Most rows already carry their source message. The projected decision in a grouped work
  // can belong to an older message, so fetch only those details with bounded concurrency.
  for (let start = 0; start < items.length; start += DETAIL_CONCURRENCY) {
    const rows = await Promise.all(
      items.slice(start, start + DETAIL_CONCURRENCY).map(async work => {
        const message = await readWorkMessage(api, scope, work, account)
        return message ? projectRecord(work, message, deviceName, api) : null
      })
    )
    for (const record of rows) if (record) records.push(record)
  }
  return records
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
    if (!ownedBy(settings, scope) || !grant || !api.connectionReadiness) {
      return { snapshot: empty('unavailable') }
    }
    if (!hasAccount(grant)) return { snapshot: empty('disconnected') }
    const readiness = await api.connectionReadiness(
      scope.deviceId,
      DINGTALK_PROVIDER,
      grant.profile
    )
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
    const records = await readRecords(api, scope, items, grant, deviceName)
    if (!(await unchanged(scope, settings, grant))) return empty('unavailable')
    const policyVersion = version(grant.version) ?? null
    const capabilities: Array<MessageCenterSnapshot['capabilities'][number]> = ['refresh']
    if (policyVersion !== null && api.takeOverWork) capabilities.push('takeOver')
    if (policyVersion !== null && api.verifyWorkDelivery) capabilities.push('verifyDelivery')
    const errors = inbox.sourceErrors.filter(row => isScopedSource(row.source, grant))
    const syncGap = errors
      .filter(row => row.error.code === 'dingtalk_delegation_gap')
      .map(row => row.error.message)
      .join('\n')
    const updatedAt = items.reduce<string | null>((latest, item) => {
      const at = timestamp(item.updatedAt)
      return at && (!latest || Date.parse(at) > Date.parse(latest)) ? at : latest
    }, null)
    const status = grant.paused
      ? 'paused'
      : !grant.authorized || !settings.primary?.enabled || settings.lifecycle
        ? 'disabled'
        : errors.some(row => row.error.code !== 'dingtalk_delegation_gap')
          ? 'unavailable'
          : settings.primary.model
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
      const inbox = await api.inbox(scope.userId, scope.deviceId)
      const work = currentWork(inbox.items, grant).find(
        row => workRecordId(row) === command.recordId
      )
      const message = work ? await readWorkMessage(api, scope, work, grant) : undefined
      if (!work || !message || !(await unchanged(scope, settings, grant))) {
        throw new Error('DingTalk message is no longer available for this action')
      }
      const record = projectRecord(work, message, deviceName, api)
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
