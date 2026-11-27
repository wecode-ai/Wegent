import { createStandInOpenedReceipt } from '@/telemetry/standInOpenedReceipt'
import {
  subscribePersonalStandIn,
  type PersonalStandInSettings,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInProposal } from '@/api/standIn'
import type { MessageCenterSource } from '@/api/standInMessageCenter'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import type { RuntimeTaskAddress } from '@/types/api'
import { createContext } from 'react'

export const StandInSourceNavigationContext = createContext<string | undefined>(undefined)

export type StandInOverviewProfile = 'primary' | 'role' | 'create' | 'memory' | null
interface OverviewObservation {
  api?: StandInExecutorApi
  userId: number
  deviceId?: string
  active: boolean
  saved: PersonalStandInSettings | null | undefined
  settingsRequestKey?: string
  initialProfileId?: string
  entryRequestKey?: number
  entryRoute: string
  primaryDeviceId?: string
  onSelectLocation?(deviceId: string): void
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  requestLeave(action: () => void): void
  reload(): void
  refreshInbox(): void
  rememberProfileTrigger(): void
  closeReview(): void
  closeDetails(): void
  clearConversationSelection(): void
}
interface OverviewSnapshot {
  roleId?: string
  profile: StandInOverviewProfile
  openConnectionSettings: boolean | MessageCenterSource
  calendarRequest: number
  focusRequest: number
  exampleDraft?: { id: number; text: string }
  proposal: StandInProposal | null
  proposalError: string | null
  proposalSaveError: { id: string; message: string } | null
  resolving: boolean
  retryingSources: ReadonlySet<string>
  resolvedProposal: {
    proposal: StandInProposal
    previous: PersonalStandInSettings
    result: 'accepted' | 'rejected'
  } | null
  api?: StandInExecutorApi
  userId?: number
  deviceId?: string
}

/** Owns the overview's proposal feed, explicit navigation and proposal transactions. */
export function createStandInOverviewSource(initial: {
  roleId?: string
  profile: StandInOverviewProfile
  calendarRequest: number
  settingsRequestKey?: string
  entryRequestKey?: number
}) {
  let snapshot: OverviewSnapshot = {
    roleId: initial.roleId,
    profile: initial.profile,
    openConnectionSettings: false,
    calendarRequest: initial.calendarRequest,
    focusRequest: 0,
    proposal: null,
    proposalError: null,
    proposalSaveError: null,
    resolving: false,
    retryingSources: new Set(),
    resolvedProposal: null,
  }
  const listeners = new Set<() => void>()
  let observation: OverviewObservation | undefined
  let settingsRequest = initial.settingsRequestKey
  let entryRequest = initial.entryRequestKey
  let generation = 0
  let operation = 0
  let scopeRevision = 0
  const retries = new Map<string, number>()
  let exampleSequence = 0
  let pressedInPanel = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let releaseSettings: (() => void) | undefined
  let feed:
    | {
        api?: StandInExecutorApi
        userId: number
        deviceId?: string
        roleId?: string
        active: boolean
      }
    | undefined
  const settled = new Set<string>()
  const recordOpened = createStandInOpenedReceipt()
  let visitQueued = false
  const recordVisit = () => {
    if (visitQueued) return
    visitQueued = true
    // One navigation command can update identity and panel together.
    queueMicrotask(() => {
      visitQueued = false
      recordCurrentVisit()
    })
  }
  const recordCurrentVisit = () => {
    if (!listeners.size) return
    const { profile, roleId } = snapshot
    recordOpened(
      profile === 'memory' ? 'memory' : profile === 'primary' ? 'settings' : 'overview',
      roleId ? 'role' : 'primary',
      !!observation?.active && profile !== 'role' && profile !== 'create'
    )
  }
  const publish = (patch: Partial<OverviewSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    recordVisit()
    for (const listener of listeners) listener()
  }
  const stopFeed = () => {
    generation++
    clearTimeout(timer)
    timer = undefined
  }
  const syncFeed = () => {
    const owner = observation
    if (!owner) return
    const next = {
      api: owner.api,
      userId: owner.userId,
      deviceId: owner.deviceId,
      roleId: snapshot.roleId,
      active: owner.active,
    }
    if (
      feed &&
      Object.keys(next).every(
        key => next[key as keyof typeof next] === feed![key as keyof typeof next]
      )
    )
      return
    const changedOwner =
      !feed ||
      feed.api !== next.api ||
      feed.userId !== next.userId ||
      feed.deviceId !== next.deviceId
    const changedRole = feed?.roleId !== next.roleId
    stopFeed()
    if (changedOwner || changedRole) {
      operation++
      scopeRevision++
      retries.clear()
    }
    feed = next
    if (changedOwner) settled.clear()
    publish({
      api: next.api,
      userId: next.userId,
      deviceId: next.deviceId,
      ...(changedOwner || changedRole
        ? {
            proposal: null,
            proposalError: null,
            proposalSaveError: null,
            resolving: false,
            retryingSources: new Set<string>(),
          }
        : {}),
      ...(!next.active ? { focusRequest: 0 } : {}),
      ...(changedOwner ? { resolvedProposal: null } : {}),
    })
    if (!next.active || !next.api || !next.deviceId) return
    const revision = generation
    const poll = async () => {
      try {
        const proposal = await next.api!.proposal(next.userId, next.deviceId!, next.roleId)
        if (generation === revision && listeners.size)
          publish({
            proposal: proposal && !settled.has(proposal.id) ? proposal : null,
            proposalError: null,
          })
      } catch (cause) {
        if (generation === revision && listeners.size) {
          reportStandInError('load_proposal', cause, next.deviceId)
          publish({
            proposalError: getStandInErrorMessage(cause, 'load_assistant_proposal_failed'),
          })
        }
      } finally {
        if (generation === revision && listeners.size) timer = setTimeout(poll, 3000)
      }
    }
    void poll()
  }
  const setProfile = (
    profile: StandInOverviewProfile,
    openConnectionSettings: boolean | MessageCenterSource = false
  ) =>
    publish({
      profile,
      openConnectionSettings,
      focusRequest:
        snapshot.focusRequest +
        (observation?.active && snapshot.profile !== null && profile === null ? 1 : 0),
    })
  const setRoleId = (roleId?: string) => {
    publish({ roleId })
    syncFeed()
  }
  const setCalendarRequest = (value: number | ((previous: number) => number)) =>
    publish({
      calendarRequest: typeof value === 'function' ? value(snapshot.calendarRequest) : value,
    })
  const ownsScope = (owner: OverviewObservation) =>
    listeners.size > 0 &&
    observation !== undefined &&
    observation.api === owner.api &&
    observation.userId === owner.userId &&
    observation.deviceId === owner.deviceId
  const requestNavigation = (route: string) => {
    const owner = observation
    if (!owner) return
    const [pathname, search] = route.split('?')
    if (pathname !== '/stand-in') return
    if (!search) {
      owner.requestLeave(() => {
        if (!ownsScope(owner)) return
        const current = observation!
        if (
          current.primaryDeviceId &&
          current.primaryDeviceId !== current.deviceId &&
          current.onSelectLocation
        ) {
          current.onSelectLocation(current.primaryDeviceId)
          return
        }
        current.clearConversationSelection()
        setRoleId(undefined)
        current.closeDetails()
        setCalendarRequest(0)
        setProfile(null)
        current.reload()
      })
    } else if (new URLSearchParams(search).get('view') === 'scheduled') {
      owner.requestLeave(() => {
        if (!ownsScope(owner)) return
        setCalendarRequest(value => value + 1)
        observation!.rememberProfileTrigger()
        setProfile(snapshot.roleId ? 'role' : 'primary')
      })
    }
  }
  const consumeRequests = () => {
    const owner = observation!
    if (settingsRequest !== owner.settingsRequestKey) {
      settingsRequest = owner.settingsRequestKey
      if (settingsRequest) {
        const roleId = owner.initialProfileId === '@primary' ? undefined : owner.initialProfileId
        const profile = owner.initialProfileId === '@primary' ? 'primary' : 'role'
        if (snapshot.profile === profile && snapshot.roleId === roleId) {
          owner.clearConversationSelection()
        } else {
          owner.requestLeave(() => {
            if (!ownsScope(owner)) return
            observation!.clearConversationSelection()
            setRoleId(roleId)
            observation!.rememberProfileTrigger()
            setProfile(profile)
          })
        }
      }
    }
    if (owner.active && entryRequest !== owner.entryRequestKey) {
      entryRequest = owner.entryRequestKey
      if (entryRequest !== undefined) requestNavigation(owner.entryRoute)
    }
  }
  const resolveProposal = async (accept: boolean) => {
    const owner = observation
    const proposal = snapshot.proposal
    if (
      !owner?.api ||
      !owner.deviceId ||
      !owner.saved ||
      !proposal ||
      snapshot.resolving ||
      (proposal.roleId ?? undefined) !== snapshot.roleId
    )
      return
    const revision = ++operation
    publish({ resolving: true, proposalSaveError: null })
    try {
      const applied = await owner.api.resolveProposal(
        owner.userId,
        owner.deviceId,
        proposal.id,
        accept
      )
      if (operation !== revision || !ownsScope(owner)) return
      settled.add(proposal.id)
      publish({
        proposal: null,
        resolvedProposal: {
          proposal: {
            ...proposal,
            settings: accept ? applied : proposal.settings,
            status: accept ? 'accepted' : 'rejected',
          },
          previous: owner.saved,
          result: accept ? 'accepted' : 'rejected',
        },
      })
      observation?.closeReview()
      observation?.reload()
    } catch (cause) {
      if (operation === revision && ownsScope(owner))
        publish({ proposalSaveError: { id: proposal.id, message: getStandInErrorMessage(cause) } })
    } finally {
      if (operation === revision && ownsScope(owner)) publish({ resolving: false })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: OverviewObservation, listener: () => void) {
      observation = owner
      listeners.add(listener)
      if (!releaseSettings)
        releaseSettings = subscribePersonalStandIn(value => {
          const current = observation
          if (
            listeners.size &&
            current &&
            value.userId === current.userId &&
            value.executionDeviceId === current.deviceId
          ) {
            current.reload()
          }
        })
      consumeRequests()
      recordVisit()
      syncFeed()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          stopFeed()
          operation++
          scopeRevision++
          retries.clear()
          feed = undefined
          observation = undefined
          releaseSettings?.()
          releaseSettings = undefined
        })
      }
    },
    setProfile,
    setRoleId,
    setCalendarRequest,
    requestNavigation,
    resolveProposal,
    async openTask(address: RuntimeTaskAddress) {
      const owner = observation
      if (!owner?.onOpenTask) return
      const revision = scopeRevision
      await owner.onOpenTask(address)
      if (scopeRevision === revision && ownsScope(owner)) observation!.closeReview()
    },
    async retrySource(source: StandInSourceConnection) {
      const owner = observation
      if (!owner?.api || !owner.deviceId) return
      const revision = scopeRevision
      const key = standInOverviewSourceKey(source)
      retries.set(key, (retries.get(key) ?? 0) + 1)
      publish({ retryingSources: new Set(retries.keys()) })
      try {
        await owner.api.retrySource(owner.userId, owner.deviceId, source)
        if (scopeRevision === revision && ownsScope(owner)) observation!.refreshInbox()
      } catch (cause) {
        if (scopeRevision === revision && ownsScope(owner))
          publish({ proposalError: getStandInErrorMessage(cause) })
      } finally {
        if (scopeRevision === revision && ownsScope(owner)) {
          const remaining = (retries.get(key) ?? 1) - 1
          if (remaining) retries.set(key, remaining)
          else retries.delete(key)
          publish({ retryingSources: new Set(retries.keys()) })
        }
      }
    },
    setExampleDraft(
      value:
        | { id: number; text: string }
        | undefined
        | ((previous: OverviewSnapshot['exampleDraft']) => OverviewSnapshot['exampleDraft'])
    ) {
      publish({ exampleDraft: typeof value === 'function' ? value(snapshot.exampleDraft) : value })
    },
    draftExample: (text: string) => publish({ exampleDraft: { id: ++exampleSequence, text } }),
    pressPanel: (inside: boolean) => {
      pressedInPanel = inside
    },
    consumeBackdropClick: () => {
      const inside = pressedInPanel
      pressedInPanel = false
      return !inside
    },
  }
}

export function standInOverviewSourceKey(source: StandInSourceConnection): string {
  return JSON.stringify([source.providerId, source.profile, source.kind, source.id])
}
