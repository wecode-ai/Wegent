import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { useCallback, useEffect, useRef, useState } from 'react'
import { dequal } from 'dequal'
import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

/** Load and save account settings on the selected Executor while preserving dirty drafts and conflicts. */
export function usePersonalStandIn(
  services: WorkbenchServices,
  userId: number,
  initialDeviceId?: string,
  localDeviceId?: string
) {
  const [saved, setSaved] = useState<PersonalStandInSettings | null>(null)
  const [draft, setDraft] = useState<PersonalStandInSettings | null>(null)
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? '')
  const [loadedDeviceId, setLoadedDeviceId] = useState(initialDeviceId)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const loaded = useRef<{
    key: string
    deviceId: string
    settings: PersonalStandInSettings
  } | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const identity = localDeviceId
        ? { deviceId: localDeviceId }
        : await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity) throw new Error('Executor identity is unavailable')
      const target = deviceId || identity.deviceId
      const settings = await services.standInApi!.personalGet(userId, target)
      if (!active) return
      const key = JSON.stringify([userId, target, reload])
      const previous = loaded.current
      loaded.current = { key, deviceId: target, settings }
      setLoadedDeviceId(target)
      setCurrentDeviceId(identity.deviceId)
      setSaved(settings)
      setDraft(current =>
        previous?.key === key && current && !dequal(current, previous.settings) ? current : settings
      )
      setError(null)
    })()
      .catch(cause => {
        if (active) {
          reportStandInError('load_settings', cause, deviceId)
          setError(getStandInErrorMessage(cause, 'load_settings_failed'))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [services, userId, deviceId, reload, localDeviceId])

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
    if (!value || saving || loading || !loaded.current) return null
    setSaving(true)
    setError(null)
    try {
      const result = await services.standInApi!.personalSave(userId, value, loaded.current.deviceId)
      if (loaded.current) loaded.current = { ...loaded.current, settings: result }
      setSaved(result)
      setDraft(result)
      return result
    } catch (cause) {
      reportStandInError('save_settings', cause, loaded.current?.deviceId)
      setError(getStandInErrorMessage(cause, 'save_settings_failed'))
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
    error,
    setError,
    loading,
    saving,
    save,
    currentDeviceId,
    loadedDeviceId,
    setDeviceId: (value: string) => {
      setLoading(true)
      setDeviceId(value)
    },
    reload: useCallback(() => {
      setLoading(true)
      setReload(value => value + 1)
    }, []),
  }
}
