import {
  dispatchTaskCommentReply,
  cardSessionAddress,
} from '@wegent/collaboration/execution/taskCardReply'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { createWorkbenchDeviceResolver } from '@/lib/workbench-device'

async function ownsInteraction(
  owner: ReturnType<typeof cardSessionAddress>,
  item: RuntimeInteraction,
  services: WorkbenchServices
): Promise<boolean> {
  if (!owner || owner.taskId !== item.task.address.taskId) return false
  if (owner.deviceId === item.task.address.deviceId) return true
  const listed = await services.deviceApi.listDevices()
  const devices = createWorkbenchDeviceResolver(listed)
  const ownerDevice = devices.resolve(owner.deviceId)
  const interactionDevice = devices.resolve(item.task.address.deviceId)
  const matches = Boolean(
    ownerDevice &&
    interactionDevice &&
    devices.identityKey(owner.deviceId) === devices.identityKey(item.task.address.deviceId)
  )
  if (!matches)
    console.warn('[RuntimeInteraction] Issue owner identity unavailable', {
      ownerDeviceId: owner.deviceId,
      interactionDeviceId: item.task.address.deviceId,
      ownerResolved: Boolean(ownerDevice),
      interactionResolved: Boolean(interactionDevice),
      devices: listed.map(device => ({
        id: device.id,
        deviceId: device.device_id,
        appDeviceId: device.app_device_id,
        runtimeInstanceId: device.runtime_instance_id,
        type: device.device_type,
      })),
    })
  return matches
}

/** Persist the reply on its owning Issue thread before continuing its execution. */
export async function replyToInteractionProject(
  item: RuntimeInteraction,
  text: string,
  clientMessageId: string,
  services: WorkbenchServices,
  failedText: string
): Promise<void> {
  const binding = item.project
  const client =
    binding?.store === 'local' ? services.localProjectChatClient : services.projectChatClient
  if (!binding?.rootCommentId || !client?.executeTaskComment)
    throw new Error(`${failedText} [interaction_issue_client_unavailable]`)
  const subscription = await client.subscribe(
    binding.projectId,
    binding.issueId,
    0,
    () => undefined
  )
  try {
    const messages = subscription.snapshot.messages
    const root = messages.find(message => message.messageId === binding.rootCommentId)
    if (!root) throw new Error(`${failedText} [interaction_issue_root_unavailable]`)
    const card = {
      root,
      replies: messages.filter(message => message.rootMessageId === root.messageId),
    }
    const owner = cardSessionAddress(card)
    if (!(await ownsInteraction(owner, item, services)))
      throw new Error(
        `${failedText} [interaction_issue_owner_mismatch] expected=${JSON.stringify({ deviceId: item.task.address.deviceId, taskId: item.task.address.taskId })} actual=${JSON.stringify(owner && { deviceId: owner.deviceId, taskId: owner.taskId })}`
      )
    const result = await dispatchTaskCommentReply({
      client,
      projectId: binding.projectId,
      taskId: binding.issueId,
      rootMessageId: card.root.messageId,
      reply: {
        id: clientMessageId,
        content: text,
        createdAt: new Date().toISOString(),
        status: 'queued',
      },
      onMessages: () => undefined,
      onError: () => undefined,
      sendFailedText: failedText,
    })
    if (!result.ok) throw new Error(result.error || failedText)
  } finally {
    subscription.unsubscribe()
  }
}
