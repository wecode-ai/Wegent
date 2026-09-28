import type { ProjectChatMessage } from "@wegent/chat-core";
import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { CollaborationExecution } from "../types";
import { resolveMessageRunStatus } from "./activityMessageUtils";

export interface RuntimeExecutionTarget {
  activityMessage?: ProjectChatMessage;
  singleExecution?: boolean;
  address: RuntimeTaskAddress;
  senderName: string;
  taskTitle?: string | null;
  modelName?: string | null;
  runId?: string | null;
  runStatus?: string | null;
}

export function executionRuntimeAddress(
  execution: CollaborationExecution,
): RuntimeTaskAddress | null {
  return execution.runtime_device_id && execution.runtime_task_id
    ? {
        deviceId: execution.runtime_device_id,
        taskId: execution.runtime_task_id,
      }
    : null;
}

export function messageRuntimeExecutionTarget(
  message: ProjectChatMessage,
  execution?: CollaborationExecution,
): RuntimeExecutionTarget | null {
  const address =
    message.runtimeAddress?.deviceId && message.runtimeAddress.taskId
      ? message.runtimeAddress
      : execution
        ? executionRuntimeAddress(execution)
        : null;
  if (!address) return null;
  return {
    address,
    activityMessage: { ...message, runtimeAddress: address },
    senderName: message.sender.name,
    taskTitle: execution?.task_title,
    runId:
      typeof message.metadata.run_id === "string"
        ? message.metadata.run_id
        : execution
          ? String(execution.id)
          : null,
    modelName:
      typeof message.metadata.model === "string"
        ? message.metadata.model
        : null,
    runStatus: resolveMessageRunStatus(undefined, message),
  };
}
