import type { ProjectChatMessage, ProjectChatClient } from "@wegent/chat-core";
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
  const messages = [card.root, ...card.replies].filter(
    (message) => message.sender.type === "agent",
  );
  const currentAddress = cardSessionAddress(card);
  const live = currentAddress ? busy(currentAddress) : undefined;
  if (live !== undefined) return live;
  const current = messages.at(-1);
  return current?.status === "pending" || current?.status === "streaming";
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
  sessionAddress?: RuntimeTaskAddress | null;
  agent?: { id: string; name: string; systemPrompt?: string; runtime?: string };
  selfManagedExecution?: boolean;
  prepareComment?(
    text: string,
    attachments: NonNullable<RuntimePaneQueuedMessage["attachments"]>,
  ): Promise<string>;
  onPersisted?(message: ProjectChatMessage): void;
  sendFailedText: string;
}

/** Server-owned comment continuation, shared by Issue composers and the global inbox. */
export async function dispatchTaskCommentReply(input: {
  client: ProjectChatClient;
  projectId: string;
  taskId: string;
  rootMessageId: string;
  reply: RuntimePaneQueuedMessage;
  prepareComment?: TaskCardReplyInput<
    unknown,
    CommentExecutionTask
  >["prepareComment"];
  onMessages(messages: ProjectChatMessage[]): void;
  onPersisted?(message: ProjectChatMessage): void;
  onError(error: string): void;
  sendFailedText: string;
}): Promise<TaskCardDispatchResult> {
  let persisted = false;
  try {
    if (!input.reply.content.trim() || !input.client.executeTaskComment)
      throw new Error(input.sendFailedText);
    const attachments = input.reply.attachments ?? [];
    const text = input.prepareComment
      ? await input.prepareComment(input.reply.content, attachments)
      : input.reply.content;
    const message = await input.client.send({
      projectId: input.projectId,
      taskId: input.taskId,
      clientMessageId: input.reply.id,
      text,
      mentions: (input.reply.mentions ?? []).filter(
        (mention) => mention.type === "user",
      ),
      replyToMessageId: input.rootMessageId,
      model: null,
    });
    persisted = true;
    input.onPersisted?.(message);
    input.onMessages([message]);
    input.onMessages(
      await input.client.executeTaskComment({
        projectId: input.projectId,
        taskId: input.taskId,
        triggerMessageId: message.messageId,
        attachmentIds: remoteAttachmentIds(attachments),
      }),
    );
    return { ok: true, persisted };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : input.sendFailedText;
    input.onError(error);
    return { ok: false, persisted, error };
  }
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
  if (client.executeTaskComment)
    return dispatchTaskCommentReply({
      client,
      projectId: project.id,
      taskId: task.id,
      rootMessageId: card.root.messageId,
      reply,
      prepareComment: input.prepareComment,
      onMessages,
      onPersisted: input.onPersisted,
      onError: input.onError,
      sendFailedText,
    });
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
  const address = input.sessionAddress ?? cardSessionAddress(card);
  let persisted = false;
  let executionError: string | null = null;
  const onError = (error: string) => {
    executionError = error;
    input.onError(error);
  };
  if (!reply.content.trim())
    return { ok: false, persisted, error: sendFailedText };
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
        ...(agent && !input.selfManagedExecution
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
    if (agent) {
      if (input.selfManagedExecution && !address)
        throw new Error(startFailedText);
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
                address,
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
