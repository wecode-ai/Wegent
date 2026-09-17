import { processingBlocks, turnStatus } from "./runtime-turn-helpers";

import { parseCodeCommentContexts } from "./code-comment-context";
import type {
  ProcessingBlock,
  RuntimeAssistantDisplayItem,
  RuntimeConversationItem,
  RuntimeConversationTurn,
  WorkbenchMessage,
} from "./runtime-conversation";

export function projectRuntimeConversationTurn(
  turn: RuntimeConversationTurn,
): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [];
  let assistantItems: RuntimeConversationItem[] = [];
  let followsGuidance = false;

  const flushAssistant = (isLast: boolean, splitBefore: boolean) => {
    const shouldProjectEmptyAssistant =
      isLast &&
      turn.status !== "done" &&
      (turn.id !== null || turn.stoppedNotice === true);
    if (assistantItems.length === 0 && !shouldProjectEmptyAssistant) {
      return;
    }
    const textItems = assistantItems.filter(
      (item) => item.type === "assistant_text",
    );
    const blocks = processingBlocks(assistantItems);
    const firstItem = assistantItems[0];
    const createdAt =
      textItems[0]?.createdAt ??
      (blocks[0] ? new Date(blocks[0].createdAt).toISOString() : "");
    messages.push({
      id: `runtime-view:${turn.id ?? turn.clientUserMessageId ?? "pending"}:${
        firstItem?.id ?? "assistant"
      }`,
      role: "assistant",
      content: textItems.map((item) => item.content).join("\n\n"),
      status: isLast ? turnStatus(turn) : "done",
      runtimeStatus: isLast ? turn.status : "done",
      subtaskId: turn.id ?? undefined,
      turnId: turn.id ?? undefined,
      runtimeMessageIndex: turn.runtimeMessageIndex,
      blocks: blocks.length > 0 ? blocks : undefined,
      runtimeDisplayItems: assistantItems.flatMap<RuntimeAssistantDisplayItem>(
        (item) =>
          item.type === "assistant_text"
            ? [{ id: item.id, type: item.type, content: item.content }]
            : item.type === "block"
              ? [{ id: item.id, type: item.type }]
              : [],
      ),
      fileChanges: isLast ? turn.fileChanges : undefined,
      error: isLast ? turn.error : undefined,
      errorType: isLast ? turn.errorType : undefined,
      completedAt: isLast ? turn.completedAt : undefined,
      stoppedNotice: isLast ? turn.stoppedNotice : undefined,
      contentTruncated: isLast ? turn.contentTruncated : undefined,
      streamingThinkingContent: isLast
        ? turn.streamingThinkingContent
        : undefined,
      references: isLast ? turn.references : undefined,
      memoryCitations: isLast ? turn.memoryCitations : undefined,
      runtimeGuidanceSplitBefore: splitBefore || undefined,
      runtimeGuidanceContinuation: followsGuidance || undefined,
      createdAt,
    });
    assistantItems = [];
    followsGuidance = false;
  };

  for (const item of turn.items) {
    if (item.type === "user_message") {
      const hadAssistant = assistantItems.length > 0;
      flushAssistant(false, hadAssistant);
      const parsedContexts = parseCodeCommentContexts(item.message.content);
      messages.push(
        parsedContexts
          ? {
              ...item.message,
              content: parsedContexts.content,
              codeComments: item.message.codeComments?.length
                ? item.message.codeComments
                : parsedContexts.codeComments,
            }
          : item.message,
      );
      followsGuidance = item.message.runtimeGuidance === true;
      if (followsGuidance && turn.id !== null) {
        const block = projectedGuidanceBlock(item.message, turn.id);
        assistantItems.push({ id: block.id, type: "block", block });
      }
      continue;
    }
    assistantItems.push(item);
  }
  flushAssistant(true, false);
  return messages;
}

export function projectedGuidanceBlock(
  message: WorkbenchMessage & { role: "user" },
  turnId: string,
): ProcessingBlock {
  const createdAt = Date.parse(message.createdAt ?? "");
  return {
    id: `runtime-view-guidance:${message.id}`,
    subtaskId: turnId,
    type: "tool",
    toolName: "conversation_guidance",
    toolInput: { message: message.content },
    status: message.status === "pending" ? "streaming" : "done",
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}
