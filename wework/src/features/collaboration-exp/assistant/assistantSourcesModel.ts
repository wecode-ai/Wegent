import { LOCAL_USER } from '@/api/local/localSession'
import { ApiError } from '@/api/http'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { subscribePersonalStandIn, type PersonalStandInSettings } from '@/api/personalStandIn'
import {
  isStandInBindingOwner,
  type StandInBindingTarget,
  type StandInExecutorApi,
  type StandInProposal,
} from '@/api/standIn'
import {
  getStandInAccountStopIntent,
  resolvePrimaryStandInDevice,
} from '@/features/todo/standInInstanceSource'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { invalidatesExperienceRead } from '../data/useExperienceSourceReads'

export interface AssistantSourceData {
  api: StandInExecutorApi
  scope: string
  ownerId: number
  deviceId: string
  localDeviceId: string
  settings: PersonalStandInSettings
  proposals: StandInProposal[]
  proposalsReady: boolean
}
const e2e = import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
interface SourceSnapshot {
  source?: AssistantSourceData
  failure?: { cause: unknown }
  proposalFailure?: { cause: unknown }
}
const locationsKey = (source: AssistantSourceData) =>
  JSON.stringify(source.settings.roles.map(role => [role.id, role.executionDeviceId]))

function accountReadUnavailable(cause: unknown): boolean {
  if (invalidatesExperienceRead(cause)) return false
  return cause instanceof ApiError
    ? cause.status === 408 || cause.status === 429 || cause.status >= 500
    : cause instanceof TypeError || (cause instanceof DOMException && cause.name === 'TimeoutError')
}

/** Account-bound settings and proposals share identity validation, but independent failures. */
export function createAssistantSourcesModel(
  services: WorkbenchServices,
  api: StandInExecutorApi | undefined,
  userId: number,
  scope: string,
  configuredTarget?: Pick<StandInBindingTarget, 'userId' | 'deviceId'>
) {
  let snapshot: SourceSnapshot = {}
  const listeners = new Set<() => void>()
  let sourceRevision = 0
  let proposalRevision = 0
  let includeProposals = false
  let devices: DeviceInfo[] = []
  let connected = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const publish = (next: SourceSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const clearSource = () => {
    proposalRevision++
    clearTimeout(timer)
    publish({ ...snapshot, source: undefined, proposalFailure: undefined })
  }
  const poll = async () => {
    clearTimeout(timer)
    const source = snapshot.source
    if (!listeners.size || !api || !source || !includeProposals) return
    const revision = ++proposalRevision
    const locations = [[undefined, source.deviceId], ...JSON.parse(locationsKey(source))] as [
      string | undefined,
      string,
    ][]
    const results = await Promise.allSettled(
      locations.map(async ([roleId, device]) => api.proposal(source.ownerId, device, roleId))
    )
    if (!listeners.size || revision !== proposalRevision) return
    const previous = snapshot.source
    if (!previous) return
    const rejected = results.find(result => result.status === 'rejected')
    const invalidated = results.some(
      result => result.status === 'rejected' && invalidatesExperienceRead(result.reason)
    )
    publish({
      ...snapshot,
      source: {
        ...previous,
        proposals: results.flatMap((result, index) => {
          if (result.status === 'rejected') {
            if (invalidatesExperienceRead(result.reason)) return []
            const [roleId] = locations[index]
            return previous.proposals.filter(proposal => (proposal.roleId ?? undefined) === roleId)
          }
          return result.value?.status === 'pending' &&
            result.value.settings.userId === source.ownerId
            ? [result.value]
            : []
        }),
        proposalsReady: !rejected || (previous.proposalsReady && !invalidated),
      },
      proposalFailure: rejected?.status === 'rejected' ? { cause: rejected.reason } : undefined,
    })
    if (listeners.size && revision === proposalRevision) timer = setTimeout(() => void poll(), 3000)
  }
  const load = async () => {
    if (!listeners.size || !api) return
    const revision = ++sourceRevision
    const current = () => listeners.size > 0 && revision === sourceRevision
    try {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!current()) return
      if (!identity) {
        clearSource()
        throw Object.assign(new Error(), { code: 'executor_unavailable' })
      }
      if (snapshot.source && snapshot.source.localDeviceId !== identity.deviceId) clearSource()
      if (configuredTarget && configuredTarget.userId !== userId)
        throw Object.assign(new Error(), { code: 'permission_denied' })
      let account: PersonalAssistantAccount | undefined
      let accountFailure: SourceSnapshot['failure']
      const cloud = userId !== LOCAL_USER.id ? services.personalAssistantAccountApi : undefined
      if (cloud) {
        try {
          account = (await cloud.get()) ?? undefined
        } catch (cause) {
          if (!accountReadUnavailable(cause)) throw cause
          accountFailure = { cause }
        }
      }
      if (!current()) return
      let ownerId = userId
      let deviceId: string
      if (account) {
        deviceId = await resolvePrimaryStandInDevice({
          api,
          account,
          userId,
          localDeviceId: identity.deviceId,
          devices,
          connected,
        })
        if (configuredTarget && getStandInAccountStopIntent(account, deviceId, devices)) {
          throw Object.assign(new Error(), { code: 'permission_denied' })
        }
      } else if (accountFailure) {
        const previous = snapshot.source
        const confirmedTarget =
          configuredTarget ??
          (previous && { userId: previous.ownerId, deviceId: previous.deviceId })
        if (confirmedTarget && confirmedTarget.deviceId !== identity.deviceId)
          throw accountFailure.cause
        const binding = await api.binding(identity.deviceId)
        if (!current()) return
        const target = binding.target
        if (target && !isStandInBindingOwner(target.userId, userId)) {
          throw Object.assign(new Error(), { code: 'permission_denied' })
        }
        // Only a verified local source may continue independently of the cloud account.
        // A remembered remote target must not silently turn into a local one.
        const localTarget = confirmedTarget ?? (binding.status === 'active' ? target : undefined)
        if (!localTarget || localTarget.deviceId !== identity.deviceId) throw accountFailure.cause
        if (
          !isStandInBindingOwner(localTarget.userId, userId) ||
          (target?.userId === localTarget.userId &&
            target.deviceId === localTarget.deviceId &&
            binding.status !== 'active') ||
          binding.stoppingTargets?.includes(`${localTarget.userId}:${localTarget.deviceId}`)
        ) {
          throw Object.assign(new Error(), { code: 'permission_denied' })
        }
        ownerId = localTarget.userId
        deviceId = localTarget.deviceId
      } else if (!cloud && configuredTarget) {
        deviceId = configuredTarget.deviceId
      } else {
        clearSource()
        throw Object.assign(new Error(), { code: 'executor_unavailable' })
      }
      if (!current()) return
      if (
        configuredTarget &&
        (ownerId !== configuredTarget.userId || deviceId !== configuredTarget.deviceId)
      )
        throw Object.assign(new Error(), { code: 'permission_denied' })
      if (!deviceId) {
        clearSource()
        throw Object.assign(new Error(), { code: 'executor_unavailable' })
      }
      if (
        snapshot.source &&
        (snapshot.source.ownerId !== ownerId || snapshot.source.deviceId !== deviceId)
      )
        clearSource()
      const settings = await api.personalGet(ownerId, deviceId)
      if (!current()) return
      if (settings.userId !== ownerId || settings.executionDeviceId !== deviceId)
        throw Object.assign(new Error(), { code: 'permission_denied' })
      if ((configuredTarget || accountFailure) && settings.lifecycle?.status) {
        throw Object.assign(new Error(), { code: 'permission_denied' })
      }
      const previous = snapshot.source
      const next: AssistantSourceData = {
        api,
        scope,
        ownerId,
        deviceId,
        localDeviceId: identity.deviceId,
        settings,
        proposals: [],
        proposalsReady: false,
      }
      const sameLocations = previous && locationsKey(previous) === locationsKey(next)
      if (sameLocations) {
        next.proposals = previous.proposals
        next.proposalsReady = previous.proposalsReady
      }
      publish({ ...snapshot, source: next, failure: accountFailure })
      if (!sameLocations) await poll()
    } catch (cause) {
      if (!current()) return
      if (invalidatesExperienceRead(cause)) clearSource()
      publish({ ...snapshot, failure: { cause } })
    }
  }
  const refresh = async () => {
    await Promise.all([load(), poll()])
  }
  return {
    getSnapshot: () => snapshot,
    refresh() {
      void refresh()
    },
    subscribe(
      listener: () => void,
      proposals: boolean,
      nextDevices: DeviceInfo[],
      nextConnected: boolean
    ) {
      const inputsChanged =
        devices !== nextDevices || connected !== nextConnected || includeProposals !== proposals
      devices = nextDevices
      connected = nextConnected
      listeners.add(listener)
      includeProposals = proposals
      if (listeners.size === 1) {
        if (e2e) performance.mark('wework:assistant-source-subscribe')
        unsubscribe = subscribePersonalStandIn(settings => {
          const source = snapshot.source
          if (
            (services.personalAssistantAccountApi &&
              userId !== LOCAL_USER.id &&
              settings.userId === userId) ||
            (source &&
              settings.userId === source.ownerId &&
              settings.executionDeviceId === source.deviceId)
          )
            void refresh()
        })
        void refresh()
      } else if (inputsChanged) {
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          if (e2e) performance.mark('wework:assistant-source-unsubscribe')
          sourceRevision++
          proposalRevision++
          clearTimeout(timer)
          unsubscribe?.()
          unsubscribe = undefined
        }
      }
    },
  }
}
