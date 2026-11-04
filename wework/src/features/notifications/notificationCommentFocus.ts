import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { resolveWorkbenchDeviceId } from '@/lib/workbench-device'

/** Match native execution and message identities; never infer a target from text or recency. */
export function notificationCommentFocus(
  messages: ProjectChatMessage[],
  address: RuntimeTaskAddress | undefined,
  sourceMessageIds: string[] | undefined,
  devices: DeviceInfo[]
): string | null {
  if (!address || !sourceMessageIds?.length) return null
  const matches = messages.filter(
    message =>
      message.sender.type === 'agent' &&
      message.runtimeAddress?.taskId === address.taskId &&
      resolveWorkbenchDeviceId(devices, message.runtimeAddress.deviceId) ===
        resolveWorkbenchDeviceId(devices, address.deviceId) &&
      (sourceMessageIds.includes(message.messageId) ||
        Boolean(message.triggerMessageId && sourceMessageIds.includes(message.triggerMessageId)))
  )
  return matches.length === 1 ? matches[0].messageId : null
}
