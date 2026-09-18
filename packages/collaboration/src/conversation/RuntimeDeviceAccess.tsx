import type { ReactNode } from 'react'
import { useRuntimeDeviceAccess } from './useRuntimeDeviceAccess'
import type { SharedWorkspaceRuntimeApi, RuntimeDeviceAccess } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'

export function RuntimeDeviceAccessNotice({
  access,
  error,
  retry,
  translate: t,
}: {
  access: RuntimeDeviceAccess | 'loading' | 'error'
  error?: string | null
  retry(): void
  translate: CollaborationTranslate
}) {
  return (
    <div
      data-testid="runtime-device-access"
      role={access === 'error' ? 'alert' : 'status'}
      className="px-3 py-2 text-xs leading-5 text-text-muted"
    >
      {access === 'error'
        ? error
        : t(
            access === 'app-local-only'
              ? 'activity.app_task_local_only'
              : access === 'loading'
                ? 'activity.device_access_loading'
                : 'activity.device_access_unavailable'
          )}
      {access === 'error' && (
        <button
          type="button"
          data-testid="runtime-device-access-retry"
          className="ml-2 min-h-11 min-w-11 underline md:min-h-0 md:min-w-0"
          onClick={retry}
        >
          {t('activity.retry')}
        </button>
      )}
    </div>
  )
}

export function RuntimeDeviceAccessBoundary({
  runtime,
  deviceId,
  translate,
  children,
}: {
  runtime: SharedWorkspaceRuntimeApi
  deviceId: string
  translate: CollaborationTranslate
  children: ReactNode
}) {
  const access = useRuntimeDeviceAccess(runtime, [deviceId])
  return access.get(deviceId) === 'allowed' ? (
    children
  ) : (
    <RuntimeDeviceAccessNotice
      access={access.get(deviceId)}
      error={access.error}
      retry={access.retry}
      translate={translate}
    />
  )
}
