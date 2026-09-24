import type { ProjectChatMessage } from "@wegent/chat-core";
import type { ExecutionTaskSummary } from "./IssueChatMessage";

export function issueTaskSummaryForMessage<
  Binding extends {
    device_id: string;
    task_id: string;
    task_title?: string | null;
    workflow_node_id?: string | null;
  },
>(
  message: ProjectChatMessage,
  bindings: Binding[],
  issueTitle: string,
  stages: Array<{ id: string; name: string }> | undefined,
  onOpen?: (binding: Binding) => void,
): ExecutionTaskSummary | undefined {
  const address = message.runtimeAddress;
  if (
    message.sender.type !== "agent" ||
    message.metadata.executor_type === "automation_manager" ||
    message.metadata.conversation_only === true
  )
    return;
  const workflowNodeId =
    typeof message.metadata.workflow_node_id === "string"
      ? message.metadata.workflow_node_id
      : undefined;
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
  const stage = stages?.find(
    (candidate) =>
      candidate.id === (binding?.workflow_node_id ?? workflowNodeId),
  );
  if (!binding && !stage && !workflowTaskTitle) return;
  return {
    title:
      binding?.task_title || workflowTaskTitle || stage?.name || issueTitle,
    stageName: stage?.name ?? null,
    onOpen: binding && onOpen ? () => onOpen(binding) : undefined,
  };
}
