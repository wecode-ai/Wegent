import type { ProjectChatMessage } from "@wegent/chat-core";
import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { ExecutionTaskSummary } from "./IssueChatMessage";

export function issueTaskSummaryForMessage<
  Binding extends {
    device_id: string;
    task_id: string;
    task_title?: string | null;
  },
>(
  message: ProjectChatMessage,
  bindings: Binding[],
  issueTitle: string,
  onOpen?: (binding: Binding) => void,
  onOpenProjectExecution?: (address: RuntimeTaskAddress) => void,
): ExecutionTaskSummary | undefined {
  const address = message.runtimeAddress;
  if (
    message.sender.type !== "agent" ||
    message.metadata.conversation_only === true
  )
    return;
  const workflowTaskTitle =
    typeof message.metadata.workflow_task_title === "string"
      ? message.metadata.workflow_task_title.trim()
      : "";
  const binding =
    address?.deviceId && address.taskId
      ? bindings.find(
          (candidate) =>
            candidate.device_id === address.deviceId &&
            candidate.task_id === address.taskId,
        )
      : undefined;
  const activityType = message.metadata.activity_type;
  const issueId = message.taskId;
  const openProjectExecution =
    onOpenProjectExecution &&
    address?.deviceId &&
    address.taskId &&
    issueId &&
    (activityType === "member_execution" ||
      activityType === "manager_execution")
      ? () =>
          onOpenProjectExecution({
            ...address,
            projectSession: {
              projectId: message.projectId,
              issueId,
            },
          })
      : undefined;
  const taskTitle =
    workflowTaskTitle ||
    binding?.task_title?.trim() ||
    (openProjectExecution && activityType === "manager_execution"
      ? issueTitle.trim()
      : "");
  if (!taskTitle) return;
  return {
    title: taskTitle,
    stageName: null,
    onOpen: binding && onOpen ? () => onOpen(binding) : openProjectExecution,
  };
}
