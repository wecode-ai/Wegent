import type { ProjectChatMessage } from "@wegent/chat-core";
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
  _issueTitle: string,
  onOpen?: (binding: Binding) => void,
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
  const taskTitle = workflowTaskTitle || binding?.task_title?.trim();
  if (!taskTitle) return;
  return {
    title: taskTitle,
    stageName: null,
    onOpen: binding && onOpen ? () => onOpen(binding) : undefined,
  };
}
