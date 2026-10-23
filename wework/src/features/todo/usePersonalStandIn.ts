import { useCallback, useEffect, useRef, useState } from 'react'
import { dequal } from 'dequal'
import type {
  PersonalStandInAgent,
  PersonalStandInSettings,
  StandInRole,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

export function usePersonalStandIn(
  services: WorkbenchServices,
  userId: number,
  initialDeviceId?: string,
  loadAgents = true
) {
  const [saved, setSaved] = useState<PersonalStandInSettings | null>(null)
  const [draft, setDraft] = useState<PersonalStandInSettings | null>(null)
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [loadDeviceId, setLoadDeviceId] = useState(initialDeviceId ?? '')
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? '')
  const [agents, setAgents] = useState<PersonalStandInAgent[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)
  const [agentReload, setAgentReload] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const loaded = useRef<{ key: string; settings: PersonalStandInSettings } | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity) throw new Error('Executor identity is unavailable')
      const target = deviceId || identity.deviceId
      if (!active) return
      setCurrentDeviceId(identity.deviceId)
      setLoadDeviceId(target)
      const settings = await services.standInApi!.personalGet(userId, target)
      if (!active) return
      const key = JSON.stringify([userId, target, reload])
      const previous = loaded.current
      loaded.current = { key, settings }
      setSaved(settings)
      setDraft(current =>
        previous?.key === key && current && !dequal(current, previous.settings) ? current : settings
      )
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
    if (!loadAgents) return
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
  }, [services, userId, deviceId, agentReload, loadAgents])

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
      if (loaded.current) loaded.current = { ...loaded.current, settings: result }
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
    agents: loadAgents ? agents : [],
    agentError: loadAgents ? agentError : null,
    reloadAgents: () => setAgentReload(value => value + 1),
    error,
    setError,
    loading,
    saving,
    save,
    currentDeviceId,
    loadDeviceId,
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
