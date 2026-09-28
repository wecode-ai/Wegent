import type { ProjectChatMessage } from "@wegent/chat-core";
import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { RuntimePaneQueuedMessage } from "@wegent/chat-core/conversation-queue";
import { remoteAttachmentIds } from "@wegent/chat-core/runtime-attachments";
import {
  startTaskAiRun,
  type CommentExecutionTask,
  type StartTaskAiRunInput,
} from "./taskAiExecution";

export interface TaskReplyCard {
  root: ProjectChatMessage;
  replies: ProjectChatMessage[];
}
export function commentAgentMentions(
  text: string,
  agents: { id: string; name: string }[],
) {
  return agents
    .filter((agent) => {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|\\s)@${escaped}(?=$|\\s|[，。！？,!?])`).test(
        text,
      );
    })
    .map((agent) => ({
      type: "agent" as const,
      id: agent.id,
      label: agent.name,
    }));
}
export interface TaskCardDispatchResult {
  ok: boolean;
  persisted: boolean;
  error?: string;
}
export function cardSessionAddress(
  card: TaskReplyCard,
): RuntimeTaskAddress | null {
  const message = [card.root, ...card.replies]
    .filter(
      (message) =>
        message.sender.type === "agent" &&
        message.runtimeAddress?.deviceId &&
        message.runtimeAddress.taskId,
    )
    .at(-1);
  return message?.runtimeAddress ?? null;
}
export function cardSessionActive(
  card: TaskReplyCard,
  busy: (address: RuntimeTaskAddress) => boolean | undefined,
): boolean {
  return [card.root, ...card.replies].some((message) => {
    if (message.sender.type !== "agent") return false;
    const recordedStatus = message.status.toLowerCase();
    if (
      ["completed", "failed", "cancelled", "canceled"].includes(recordedStatus)
    ) {
      return false;
    }
    const running = message.runtimeAddress
      ? busy(message.runtimeAddress)
      : undefined;
    return (
      running ??
      (message.status === "pending" || message.status === "streaming")
    );
  });
}
export interface TaskCardReplyInput<
  Project,
  Task extends CommentExecutionTask,
> extends Omit<
  StartTaskAiRunInput<Project, Task>,
  "agent" | "prompt" | "trigger" | "replyTo" | "threadRootId"
> {
  card: TaskReplyCard;
  reply: RuntimePaneQueuedMessage;
  agent?: { id: string; name: string; systemPrompt?: string; runtime?: string };
  selfManagedExecution?: boolean;
  prepareComment?(
    text: string,
    attachments: NonNullable<RuntimePaneQueuedMessage["attachments"]>,
  ): Promise<string>;
  onPersisted?(message: ProjectChatMessage): void;
  sendFailedText: string;
}

/** The PC reply flow, shared by native and browser hosts. */
export async function dispatchTaskCardReply<
  Project,
  Task extends CommentExecutionTask,
>(input: TaskCardReplyInput<Project, Task>): Promise<TaskCardDispatchResult> {
  const {
    client,
    project,
    task,
    card,
    reply,
    onMessages,
    startFailedText,
    sendFailedText,
  } = input;
  const previousAgent = [card.root, ...card.replies]
    .filter((message) => message.sender.type === "agent")
    .at(-1);
  const agent = previousAgent
    ? input.agent?.id === (previousAgent.agentId || previousAgent.sender.id)
      ? input.agent
      : {
          id: previousAgent.agentId || previousAgent.sender.id,
          name: previousAgent.sender.name,
          runtime:
            previousAgent.metadata.executor_type === "wegent_team"
              ? "wegent"
              : previousAgent.runtimeAddress?.runtime,
        }
    : input.agent;
  const rootId = card.root.messageId;
  const attachments = reply.attachments ?? [];
  const address = cardSessionAddress(card);
  let persisted = false;
  let executionError: string | null = null;
  const onError = (error: string) => {
    executionError = error;
    input.onError(error);
  };
  if (!reply.content.trim())
    return { ok: false, persisted, error: sendFailedText };
  const serverExecution =
    project.project_store === "backend" && client.executeTaskComment;
  try {
    const text = input.prepareComment
      ? await input.prepareComment(reply.content, attachments)
      : reply.content;
    const message = await client.send({
      projectId: project.id,
      taskId: task.id,
      clientMessageId: reply.id,
      text,
      // A local self-managed reply is continued below through the card's
      // runtime address. Mention-driven enqueue is reserved for a new root
      // comment; including the mention here would create a second session.
      mentions: [
        ...(!serverExecution &&
        agent &&
        !(input.selfManagedExecution && address)
          ? [{ type: "agent" as const, id: agent.id, label: agent.name }]
          : []),
        // Members the reply composer mentioned are addressed, not enqueued.
        ...(reply.mentions ?? []).filter((mention) => mention.type === "user"),
      ],
      replyToMessageId: rootId,
      model: null,
    });
    persisted = true;
    input.onPersisted?.(message);
    onMessages([message]);
    if (serverExecution) {
      onMessages(
        await serverExecution({
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: message.messageId,
          attachmentIds: remoteAttachmentIds(attachments),
        }),
      );
    } else if (agent && (!input.selfManagedExecution || address)) {
      if (agent.runtime === "wegent") {
        if (!client.continueWegentTask) throw new Error(startFailedText);
        onMessages([
          await client.continueWegentTask({
            projectId: project.id,
            taskId: task.id,
            triggerMessageId: message.messageId,
            agentId: agent.id,
            attachmentIds: remoteAttachmentIds(attachments),
          }),
        ]);
      } else {
        const started = await startTaskAiRun({
          ...input,
          agent,
          prompt: reply.content,
          trigger: message,
          attachments,
          replyTo: address
            ? {
                runtimeDeviceId: address.deviceId,
                runtimeTaskId: address.taskId,
              }
            : null,
          threadRootId: rootId,
          onError,
        });
        if (!started)
          return {
            ok: false,
            persisted,
            error: executionError ?? startFailedText,
          };
      }
    }
    return { ok: true, persisted };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : sendFailedText;
    onError(error);
    return { ok: false, persisted, error };
  }
}
