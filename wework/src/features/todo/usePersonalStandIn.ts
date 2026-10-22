import { useCallback, useEffect, useState } from 'react'
import type {
  PersonalStandInAgent,
  PersonalStandInSettings,
  StandInRole,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

export function usePersonalStandIn(
  services: WorkbenchServices,
  userId: number,
  initialDeviceId?: string
) {
  const [saved, setSaved] = useState<PersonalStandInSettings | null>(null)
  const [draft, setDraft] = useState<PersonalStandInSettings | null>(null)
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? '')
  const [agents, setAgents] = useState<PersonalStandInAgent[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity) throw new Error('Executor identity is unavailable')
      const target = deviceId || identity.deviceId
      const settings = await services.standInApi!.personalGet(userId, target)
      if (!active) return
      setCurrentDeviceId(identity.deviceId)
      setSaved(settings)
      setDraft(settings)
      setError(null)
    })()
      .catch(cause => {
        if (active) setError(String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [services, userId, deviceId, reload])

  useEffect(() => {
    let active = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity) throw new Error('Executor identity is unavailable')
      return services.standInApi!.personalAgents(userId, deviceId || identity.deviceId)
    })()
      .then(rows => {
        if (active) {
          setAgents(rows)
          setAgentError(null)
        }
      })
      .catch(cause => {
        if (active) setAgentError(String(cause))
      })
    return () => {
      active = false
    }
  }, [services, userId, deviceId])

  const updateRole = useCallback((id: string, update: (role: StandInRole) => StandInRole) => {
    setDraft(
      current =>
        current && {
          ...current,
          roles: current.roles.map(role => (role.id === id ? update(role) : role)),
        }
    )
  }, [])

  const save = async (value = draft) => {
    if (!value || saving) return null
    setSaving(true)
    setError(null)
    try {
      const result = await services.standInApi!.personalSave(userId, value)
      setSaved(result)
      setDraft(result)
      return result
    } catch (cause) {
      setError(String(cause))
      return null
    } finally {
      setSaving(false)
    }
  }
  return {
    saved,
    draft,
    setDraft,
    updateRole,
    agents,
    agentError,
    error,
    setError,
    loading,
    saving,
    save,
    currentDeviceId,
    setDeviceId: (value: string) => {
      setLoading(true)
      setDeviceId(value)
    },
    reload: () => {
      setLoading(true)
      setReload(value => value + 1)
    },
  }
}
