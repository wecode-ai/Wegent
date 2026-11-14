import { useCallback, useContext, useEffect, useState } from 'react'
import { LOCAL_USER } from '@/api/local/localSession'
import { subscribePersonalStandIn, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInProposal } from '@/api/standIn'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useStandInInbox } from '@/features/todo/useStandInInbox'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { invalidatesExperienceRead } from '../data/useExperienceSourceReads'

interface AssistantSourceData {
  api: StandInExecutorApi
  scope: string
  ownerId: number
  deviceId: string
  localDeviceId: string
  settings: PersonalStandInSettings
  proposals: StandInProposal[]
  proposalsReady: boolean
}

interface AssistantSourceFailure {
  scope: string
  api: StandInExecutorApi
  message: string
}

export function useAssistantSources(active: boolean, includeProposals = true) {
  const { services, state } = useWorkbench()
  const cloud = useContext(CloudConnectionContext)
  const userId = Number(state.user?.id ?? LOCAL_USER.id)
  const backendUrl = cloud?.apiBaseUrl ?? ''
  const scope = JSON.stringify([userId, backendUrl])
  const [data, setData] = useState<AssistantSourceData>()
  const [failure, setFailure] = useState<AssistantSourceFailure>()
  const [proposalFailure, setProposalFailure] = useState<AssistantSourceFailure>()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const api = services.standInApi

  useEffect(() => {
    if (!active || !api) return
    let current = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!current) return
      if (!identity) {
        setData(previous => (previous?.scope === scope ? undefined : previous))
        throw Object.assign(new Error(), { code: 'executor_unavailable' })
      }
      setData(previous =>
        previous?.scope === scope &&
        (previous.api !== api || previous.localDeviceId !== identity.deviceId)
          ? undefined
          : previous
      )
      const binding = await api.binding(identity.deviceId)
      if (!current) return
      const target = binding.target
      if (
        target &&
        target.userId !== LOCAL_USER.id &&
        (target.userId !== userId || (target.backendUrl ?? '') !== backendUrl)
      ) {
        throw Object.assign(new Error(), { code: 'permission_denied' })
      }
      const ownerId = target?.userId ?? userId
      const deviceId = target?.deviceId ?? identity.deviceId
      setData(previous =>
        previous?.scope === scope &&
        (previous.ownerId !== ownerId || previous.deviceId !== deviceId)
          ? undefined
          : previous
      )
      const settings = await api.personalGet(ownerId, deviceId)
      if (settings.userId !== ownerId || settings.executionDeviceId !== deviceId)
        throw Object.assign(new Error(), { code: 'permission_denied' })
      if (!current) return
      setData(previous => {
        const sameSources =
          previous?.scope === scope &&
          previous.ownerId === ownerId &&
          previous.deviceId === deviceId &&
          JSON.stringify(previous.settings.roles.map(role => [role.id, role.executionDeviceId])) ===
            JSON.stringify(settings.roles.map(role => [role.id, role.executionDeviceId]))
        return {
          api,
          scope,
          ownerId,
          deviceId,
          localDeviceId: identity.deviceId,
          settings,
          proposals: sameSources ? previous.proposals : [],
          proposalsReady: sameSources ? previous.proposalsReady : false,
        }
      })
      setFailure(undefined)
    })().catch(cause => {
      if (current) {
        if (invalidatesExperienceRead(cause))
          setData(previous => (previous?.scope === scope ? undefined : previous))
        setFailure({ scope, api, message: getStandInErrorMessage(cause) })
      }
    })
    return () => {
      current = false
    }
  }, [active, api, services, userId, backendUrl, scope, revision])

  const source = data?.scope === scope && data.api === api ? data : undefined
  const ownerId = source?.ownerId ?? userId
  const deviceId = source?.deviceId
  const roleLocations = JSON.stringify(
    source?.settings.roles.map(role => [role.id, role.executionDeviceId]) ?? []
  )

  useEffect(() => {
    if (!active || !api || !deviceId || !includeProposals) return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const locations = [[undefined, deviceId], ...JSON.parse(roleLocations)] as [
        string | undefined,
        string,
      ][]
      const results = await Promise.allSettled(
        locations.map(([roleId, device]) => api.proposal(ownerId, device, roleId))
      )
      if (!current) return
      const rejected = results.find(result => result.status === 'rejected')
      const invalidated = results.some(
        result => result.status === 'rejected' && invalidatesExperienceRead(result.reason)
      )
      setData(previous =>
        previous?.scope === scope &&
        previous.ownerId === ownerId &&
        previous.deviceId === deviceId &&
        JSON.stringify(previous.settings.roles.map(role => [role.id, role.executionDeviceId])) ===
          roleLocations
          ? {
              ...previous,
              proposals: results.flatMap((result, index) => {
                if (result.status === 'rejected') {
                  if (invalidatesExperienceRead(result.reason)) return []
                  const [roleId] = locations[index]
                  return previous.proposals.filter(
                    proposal => (proposal.roleId ?? undefined) === roleId
                  )
                }
                return result.value?.status === 'pending' &&
                  result.value.settings.userId === ownerId
                  ? [result.value]
                  : []
              }),
              proposalsReady: !rejected || (previous.proposalsReady && !invalidated),
            }
          : previous
      )
      if (rejected?.status === 'rejected')
        setProposalFailure({ scope, api, message: getStandInErrorMessage(rejected.reason) })
      else setProposalFailure(previous => (previous?.scope === scope ? undefined : previous))
      timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [active, api, ownerId, deviceId, roleLocations, scope, revision, includeProposals])

  useEffect(
    () =>
      subscribePersonalStandIn(settings => {
        if (
          source &&
          settings.userId === source.ownerId &&
          settings.executionDeviceId === source.deviceId
        )
          refresh()
      }),
    [source, refresh]
  )

  const inbox = useStandInInbox(api, ownerId, deviceId, active)
  const currentFailure = failure?.scope === scope && failure.api === api ? failure : undefined
  const currentProposalFailure =
    proposalFailure?.scope === scope && proposalFailure.api === api ? proposalFailure : undefined
  return {
    ...source,
    scope,
    userId,
    loading: active && Boolean(api) && !source && !currentFailure,
    error: !api
      ? getStandInErrorMessage({ code: 'executor_unavailable' })
      : currentFailure
        ? currentFailure.message
        : currentProposalFailure
          ? currentProposalFailure.message
          : inbox.error,
    inbox,
    inboxReady: Boolean(deviceId && inbox.scope === `${ownerId}:${deviceId}`),
    refresh,
  }
}
