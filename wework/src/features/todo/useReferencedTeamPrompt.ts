import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { StandInExecutorApi } from '@/api/standIn'

export function useReferencedTeamPrompt(
  api: StandInExecutorApi | undefined,
  userId: number,
  deviceId: string | undefined,
  roleId: string | undefined,
  teamRef: string | null | undefined
) {
  const resource = useMemo(() => {
    if (!api || !deviceId || !roleId || !teamRef?.startsWith('LA-')) return
    return createAsyncResource(JSON.stringify([userId, deviceId, roleId, teamRef]), async () => {
      const settings = await api.personalGet(userId, deviceId, {
        deviceSettingsOnly: true,
        promptTeamRoleId: roleId,
      })
      const role =
        roleId === '@primary' ? settings.primary : settings.roles.find(role => role.id === roleId)
      if (role?.teamRef !== teamRef || typeof settings.referencedTeamPrompt !== 'string')
        throw new Error('The executor did not return the referenced Team prompt')
      return settings.referencedTeamPrompt
    })
  }, [api, userId, deviceId, roleId, teamRef])
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot
  )
  const [edit, setEdit] = useState<{ resource: typeof resource; prompt: string }>()
  const prompt = edit && edit.resource === resource ? edit.prompt : snapshot.data
  return {
    linked: Boolean(resource),
    prompt,
    edited: Boolean(resource && prompt !== snapshot.data),
    ready: !resource || snapshot.status === 'ready',
    error: snapshot.error,
    retry: () => void resource?.reload(),
    setPrompt: (prompt: string) => setEdit({ resource, prompt }),
  }
}
