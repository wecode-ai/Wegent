// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import type { UserPreferences } from '@/types/api'
import type { ActionDispatch, RefObject } from 'react'
import { useCallback } from 'react'
import type { WorkbenchAction } from './workbenchReducer'
import type { WorkbenchServices } from './workbenchServices'
export function useUpdateUserPreferences({
  resolvedServices,
  latestUserPreferencesRef,
  dispatch,
}: {
  resolvedServices: WorkbenchServices
  latestUserPreferencesRef: RefObject<UserPreferences | null | undefined>
  dispatch: ActionDispatch<[action: WorkbenchAction]>
}) {
  return useCallback(
    async (patch: UserPreferences): Promise<UserPreferences> => {
      const userApi = resolvedServices.userApi
      if (!userApi) {
        throw new Error('User preferences are unavailable')
      }
      const previousPreferences = latestUserPreferencesRef.current ?? {}
      const updatedUser = await userApi.updateCurrentUser({ preferences: patch })
      const preferences = {
        ...previousPreferences,
        ...patch,
        ...(updatedUser.preferences ?? {}),
      }
      latestUserPreferencesRef.current = preferences
      dispatch({ type: 'user_preferences_updated', preferences })
      return preferences
    },
    [dispatch, latestUserPreferencesRef, resolvedServices.userApi]
  )
}
