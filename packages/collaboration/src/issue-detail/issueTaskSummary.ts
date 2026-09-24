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
  issueTitle: string,
  onOpen?: (binding: Binding) => void,
): ExecutionTaskSummary | undefined {
  const address = message.runtimeAddress;
  if (
    message.sender.type !== "agent" ||
    message.metadata.executor_type === "automation_manager" ||
    message.metadata.conversation_only === true
  )
    return;
  const dispatchTaskTitle =
    typeof message.metadata.dispatch_task_title === "string"
      ? message.metadata.dispatch_task_title.trim()
      : "";
  const binding =
    address?.deviceId && address.taskId
      ? bindings.find(
          (candidate) =>
            candidate.device_id === address.deviceId &&
            candidate.task_id === address.taskId,
        )
      : undefined;
  if (!binding && !dispatchTaskTitle) return;
  return {
    title: binding?.task_title || dispatchTaskTitle || issueTitle,
    stageName: null,
    onOpen: binding && onOpen ? () => onOpen(binding) : undefined,
  };
}
