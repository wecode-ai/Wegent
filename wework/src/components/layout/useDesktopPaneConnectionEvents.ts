import { supportsConnectionEvents } from '@/lib/device-capabilities'
import { cancelConnectionEventSubscription } from '@/api/connectionEventSubscriptions'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { TFunction } from 'i18next'
import { useCallback } from 'react'

export function useDesktopPaneConnectionEvents({
  activeDevice,
  activeDeviceUnavailable,
  deviceApi,
  currentRuntimeTask,
  t,
}: {
  activeDevice: DeviceInfo | null | undefined
  activeDeviceUnavailable: boolean
  deviceApi: WorkbenchServices['deviceApi']
  currentRuntimeTask: RuntimeTaskAddress | null
  t: TFunction<'common'>
}) {
  const eventCancellationUnsupported =
    !activeDeviceUnavailable && !supportsConnectionEvents(activeDevice)
  const cancelCurrentEventSubscription = useCallback(
    async (key: string) => {
      if (!deviceApi || !currentRuntimeTask || activeDeviceUnavailable)
        throw new Error(
          t('workbench.connection_event_cancel_unavailable', '设备离线，恢复后可取消')
        )
      if (eventCancellationUnsupported)
        throw new Error(
          t('workbench.connection_event_upgrade_required', '此设备需升级执行器以使用事件监听')
        )
      await cancelConnectionEventSubscription(deviceApi, currentRuntimeTask, key, activeDevice)
    },
    [
      deviceApi,
      currentRuntimeTask,
      activeDevice,
      activeDeviceUnavailable,
      eventCancellationUnsupported,
      t,
    ]
  )
  const eventSubscriptionScope = currentRuntimeTask
    ? JSON.stringify([
        currentRuntimeTask.deviceId,
        currentRuntimeTask.taskId,
        currentRuntimeTask.workspacePath,
        activeDevice?.runtime_instance_id,
        activeDevice?.executor_version,
        eventCancellationUnsupported,
      ])
    : ''
  return { eventCancellationUnsupported, cancelCurrentEventSubscription, eventSubscriptionScope }
}
