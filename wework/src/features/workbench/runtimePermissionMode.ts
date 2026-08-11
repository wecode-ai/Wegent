import type { ModelOptions } from '@/types/api'

export const RUNTIME_PERMISSION_MODE_OPTION = 'permissionMode'

export type RuntimePermissionMode = 'read-only' | 'workspace-write' | 'full-access'

export const DEFAULT_RUNTIME_PERMISSION_MODE: RuntimePermissionMode = 'workspace-write'

export function runtimePermissionMode(options?: ModelOptions): RuntimePermissionMode {
  const value = options?.[RUNTIME_PERMISSION_MODE_OPTION]
  if (value === 'read-only' || value === 'full-access') return value
  return DEFAULT_RUNTIME_PERMISSION_MODE
}

export function runtimePermissionProfile(mode: RuntimePermissionMode): string {
  switch (mode) {
    case 'read-only':
      return ':read-only'
    case 'workspace-write':
      return ':workspace'
    case 'full-access':
      return ':danger-full-access'
  }
}
