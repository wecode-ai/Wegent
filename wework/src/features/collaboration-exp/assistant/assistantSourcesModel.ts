import { subscribePersonalStandIn, type PersonalStandInSettings } from '@/api/personalStandIn'
import {
  type StandInBindingTarget,
  type StandInExecutorApi,
  type StandInProposal,
} from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
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
      const account = configuredTarget
        ? undefined
        : await services.personalAssistantAccountApi?.get()
      if (!current()) return
      if (configuredTarget && configuredTarget.userId !== userId)
        throw Object.assign(new Error(), { code: 'permission_denied' })
      const ownerId = userId
      const deviceId =
        configuredTarget?.deviceId ??
        account?.definitions.find(definition => definition.roleId === '@primary')?.bot.spec
          ?.execution_policy?.environment_id
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
      publish({ ...snapshot, source: next, failure: undefined })
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
    subscribe(listener: () => void, proposals: boolean) {
      listeners.add(listener)
      includeProposals = proposals
      if (listeners.size === 1) {
        if (e2e) performance.mark('wework:assistant-source-subscribe')
        unsubscribe = subscribePersonalStandIn(settings => {
          const source = snapshot.source
          if (
            source &&
            settings.userId === source.ownerId &&
            settings.executionDeviceId === source.deviceId
          )
            void refresh()
        })
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
