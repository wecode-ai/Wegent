import type { ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@/types/api'
import { isPublicStandInMessage } from '@/features/todo/issueActivityRole'
import { hasThreadWorkOwner } from './threadPersonalTaskAccess'
import type { ThreadActionContext } from './threadActions'

/** Public activity does not grant private Runtime access; its existing navigator retains that policy. */
export async function openThreadExecution({
  context,
  message,
  open,
  isCurrent,
  unavailable,
}: {
  context: ThreadActionContext
  message: ProjectChatMessage
  open(address: RuntimeTaskAddress): void | Promise<void>
  isCurrent(): boolean
  unavailable: string
}) {
  const address = message.runtimeAddress
  if (
    !isCurrent() ||
    !hasThreadWorkOwner(context) ||
    message.taskId !== context.item.id ||
    message.projectId !== context.group.id ||
    message.sender.type !== 'agent' ||
    isPublicStandInMessage(message) ||
    !address?.deviceId ||
    !address.taskId
  )
    throw new Error(unavailable)
  const item = await context.api.issues.get(context.item.id)
  if (
    !isCurrent() ||
    item.group_id !== context.group.id ||
    String(item.cloud_project_id) !== context.group.id ||
    item.id !== context.item.id
  )
    throw new Error(unavailable)
  const executionId = message.metadata.execution_id
  if (executionId != null) {
    if (
      !context.api.executions ||
      !Number.isSafeInteger(Number(executionId)) ||
      Number(executionId) <= 0
    )
      throw new Error(unavailable)
    const executions = await context.api.executions.list(context.group.id, {
      includeTerminal: true,
    })
    if (
      !executions.some(
        execution =>
          execution.id === Number(executionId) &&
          execution.loop_item_id === item.id &&
          String(execution.cloud_project_id) === context.group.id &&
          execution.runtime_task_id === address.taskId &&
          execution.runtime_device_id === address.deviceId
      )
    )
      throw new Error(unavailable)
  } else {
    const bindings = await context.api.taskBindings?.list(item.id, context.group.id)
    if (
      !bindings?.some(
        binding =>
          binding.issueId === item.id &&
          binding.projectId === context.group.id &&
          String(binding.taskUserId) === String(context.participation?.current_user_id) &&
          binding.taskId === address.taskId &&
          binding.deviceId === address.deviceId
      )
    )
      throw new Error(unavailable)
  }
  if (!isCurrent()) throw new Error(unavailable)
  await open(address)
}
