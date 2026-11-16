import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  loadRuntimePermissionMode,
  saveRuntimePermissionMode,
  type RuntimePermissionMode,
} from '@/services/runtimePermissionPreference'

export function useRuntimePermissionPreference() {
  const [permissionMode, setPermissionMode] = useState<RuntimePermissionMode>(
    DEFAULT_RUNTIME_PERMISSION_MODE
  )
  useEffect(() => {
    let active = true
    void loadRuntimePermissionMode()
      .then(stored => {
        if (active) setPermissionMode(stored)
      })
      .catch(cause => console.warn('Failed to load runtime permission preference', cause))
    return () => {
      active = false
    }
  }, [])
  const selectPermissionMode = useCallback((mode: RuntimePermissionMode) => {
    setPermissionMode(mode)
    void saveRuntimePermissionMode(mode).catch(cause =>
      console.warn('Failed to save runtime permission preference', cause)
    )
  }, [])
  return { permissionMode, selectPermissionMode }
}
