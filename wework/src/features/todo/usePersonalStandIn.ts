import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  createPersonalStandInSettingsResource,
  personalStandInSettingsError,
} from './personalStandInSettingsResource'

export type PersonalStandInObservation = NonNullable<
  Parameters<ReturnType<typeof createPersonalStandInSettingsResource>['subscribe']>[1]
>

/** Load and save on the selected Executor without sharing drafts across account or device owners. */
export function usePersonalStandIn(
  services: WorkbenchServices,
  userId: number,
  initialDeviceId?: string,
  localDeviceId?: string,
  observation?: PersonalStandInObservation
) {
  const [selection, setSelection] = useState({
    userId,
    initialDeviceId,
    deviceId: initialDeviceId ?? '',
  })
  if (selection.userId !== userId || selection.initialDeviceId !== initialDeviceId) {
    setSelection({ userId, initialDeviceId, deviceId: initialDeviceId ?? '' })
  }
  const { standInApi: api, getLocalRuntimeSidebarIdentity: identify } = services
  const resource = useMemo(
    () =>
      createPersonalStandInSettingsResource({
        api,
        identify,
        userId,
        deviceId: selection.deviceId,
        localDeviceId,
      }),
    [api, identify, userId, selection.deviceId, localDeviceId]
  )
  const initialRoleKey = JSON.stringify(observation?.initialRole ?? null)
  const initialRole = useMemo(
    () => JSON.parse(initialRoleKey) as PersonalStandInObservation['initialRole'] | null,
    [initialRoleKey]
  )
  const onSavingChange = observation?.onSavingChange
  const subscribe = useCallback(
    (listener: () => void) =>
      resource.subscribe(listener, {
        initialRole: initialRole ?? undefined,
        onSavingChange,
      }),
    [resource, initialRole, onSavingChange]
  )
  const state = useSyncExternalStore(subscribe, resource.getSnapshot)
  const setDeviceId = useCallback(
    (deviceId: string) => {
      if (resource.isActive()) setSelection(current => ({ ...current, deviceId }))
    },
    [resource]
  )
  return {
    ...state,
    error: personalStandInSettingsError(state.error),
    setDraft: resource.setDraft,
    updateRole: resource.updateRole,
    setError: resource.setError,
    setMoving: resource.setMoving,
    save: resource.save,
    reload: resource.reload,
    setDeviceId,
  }
}
