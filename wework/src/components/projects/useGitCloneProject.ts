import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import type { CloneGitRepositoryInput } from '@/types/api'
import {
  createGitCloneProjectOperation,
  managedDevice,
  type GitCloneProjectOptions,
} from './gitCloneProjectOperation'

export function useGitCloneProject({
  device,
  clone,
  open,
  refreshDevices,
  onSubmittingChange,
}: GitCloneProjectOptions) {
  const cloud = useOptionalCloudConnection()
  const { t } = useTranslation('common')
  const [controller] = useState(createGitCloneProjectOperation)
  const latestCloud = useRef(cloud)
  // Credential checks can resume before passive subscription updates commit.
  useLayoutEffect(() => {
    latestCloud.current = cloud
  }, [cloud])
  const readCloud = useCallback(() => latestCloud.current, [])
  const operation = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot
  )
  const currentOperation = !device || operation?.deviceId === device.device_id ? operation : null
  return {
    operation: currentOperation,
    deviceRecovery: operation?.failureReason === 'executor-not-found',
    submitting: Boolean(
      currentOperation && !['failed', 'waiting-configuration'].includes(currentOperation.status)
    ),
    canConfigure:
      managedDevice(device) &&
      cloud.isConnected &&
      (!currentOperation ||
        currentOperation.cloudAccountKey === `${cloud.backendUrl ?? ''}:${cloud.user?.id ?? ''}`),
    submit: (input: CloneGitRepositoryInput) =>
      controller.submit(input, {
        device,
        clone,
        open,
        refreshDevices,
        onSubmittingChange,
        cloud,
        readCloud,
        translate: t,
      }),
    reset: controller.reset,
  }
}
