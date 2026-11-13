import { useCallback, useContext, useEffect, useState } from 'react'
import { LOCAL_USER } from '@/api/local/localSession'
import { subscribePersonalStandIn, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInProposal } from '@/api/standIn'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useStandInInbox } from '@/features/todo/useStandInInbox'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

interface AssistantSourceData {
  scope: string
  ownerId: number
  deviceId: string
  localDeviceId: string
  settings: PersonalStandInSettings
  proposals: StandInProposal[]
}

export function useAssistantSources(active: boolean, includeProposals = true) {
  const { services, state } = useWorkbench()
  const cloud = useContext(CloudConnectionContext)
  const userId = Number(state.user?.id ?? LOCAL_USER.id)
  const backendUrl = cloud?.apiBaseUrl ?? ''
  const scope = JSON.stringify([userId, backendUrl])
  const [data, setData] = useState<AssistantSourceData>()
  const [failure, setFailure] = useState<{ scope: string; message: string }>()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const api = services.standInApi

  useEffect(() => {
    if (!active || !api) return
    let current = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!current) return
      if (!identity) throw Object.assign(new Error(), { code: 'executor_unavailable' })
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
      const settings = await api.personalGet(ownerId, deviceId)
      if (settings.userId !== ownerId)
        throw Object.assign(new Error(), { code: 'permission_denied' })
      if (!current) return
      setData({
        scope,
        ownerId,
        deviceId,
        localDeviceId: identity.deviceId,
        settings,
        proposals: [],
      })
      setFailure(undefined)
    })().catch(cause => {
      if (current) {
        setData(previous => (previous?.scope === scope ? undefined : previous))
        setFailure({ scope, message: getStandInErrorMessage(cause) })
      }
    })
    return () => {
      current = false
    }
  }, [active, api, services, userId, backendUrl, scope, revision])

  const source = data?.scope === scope ? data : undefined
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
      setData(previous =>
        previous?.scope === scope && previous.deviceId === deviceId
          ? {
              ...previous,
              proposals: results.flatMap(result =>
                result.status === 'fulfilled' &&
                result.value?.status === 'pending' &&
                result.value.settings.userId === ownerId
                  ? [result.value]
                  : []
              ),
            }
          : previous
      )
      if (rejected?.status === 'rejected')
        setFailure({ scope, message: getStandInErrorMessage(rejected.reason) })
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
  return {
    ...source,
    userId,
    loading: active && Boolean(api) && !source && failure?.scope !== scope,
    error: !api
      ? getStandInErrorMessage({ code: 'executor_unavailable' })
      : failure?.scope === scope
        ? failure.message
        : inbox.error,
    inbox,
    refresh,
  }
}
