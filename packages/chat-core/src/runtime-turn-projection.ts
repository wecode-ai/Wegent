import { processingBlocks, turnStatus } from "./runtime-turn-helpers";
import { nestWorkbenchProcessingBlocks } from "./workbench-message-reducer";

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
  return projectRuntimeConversationTurns([turn]);
}

/** Resolve child ownership before guidance or turn boundaries split assistant views. */
export function projectRuntimeConversationTurns(
  turns: RuntimeConversationTurn[],
): WorkbenchMessage[] {
  // A child can keep streaming after guidance splits its parent's display
  // message, or after the root starts another turn. Resolve ownership first.
  const blocks = turns.flatMap((turn) => processingBlocks(turn.items));
  const nonSubagentParentIds = new Set(
    blocks
      .filter((block) => block.type !== "subagent")
      .map((block) => block.id),
  );
  const blocksById = new Map(
    nestWorkbenchProcessingBlocks(blocks)
      .filter((block) => block.type === "subagent")
      .map((block) => [block.id, block]),
  );
  return turns.flatMap((turn) =>
    projectTurn(turn, blocksById, nonSubagentParentIds),
  );
}

function projectTurn(
  turn: RuntimeConversationTurn,
  blocksById: ReadonlyMap<string, ProcessingBlock>,
  nonSubagentParentIds: ReadonlySet<string>,
): WorkbenchMessage[] {
  // A send cancelled before native turn/start has no backend history to keep.
  // Do not project its optimistic prompt after a later turn has taken the tail.
  if (
    turn.id === null &&
    turn.status === "cancelled" &&
    turn.items.every((item) => item.type === "user_message")
  ) {
    return [];
  }
  const messages: WorkbenchMessage[] = [];
  let assistantItems: RuntimeConversationItem[] = [];
  let followsGuidance = false;
  let assistantAnchor = "assistant";
  let hasUser = false;

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
    const createdAt =
      textItems[0]?.createdAt ??
      (blocks[0] ? new Date(blocks[0].createdAt).toISOString() : "");
    messages.push({
      id: `runtime-view:${turn.id ?? turn.clientUserMessageId ?? "pending"}:${assistantAnchor}`,
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
      const splitsReply =
        hasUser ||
        item.message.runtimeGuidance === true ||
        assistantItems.some((item) => item.type === "assistant_text");
      if (splitsReply) flushAssistant(false, hadAssistant);
      hasUser = true;
      const parsedContexts = parseCodeCommentContexts(item.message.content);
      const userMessage = {
        ...item.message,
        ...(turn.id ? { turnId: turn.id, subtaskId: turn.id } : {}),
        runtimeItemId: item.id,
      };
      messages.push(
        parsedContexts
          ? {
              ...userMessage,
              content: parsedContexts.content,
              codeComments: item.message.codeComments?.length
                ? item.message.codeComments
                : parsedContexts.codeComments,
            }
          : userMessage,
      );
      followsGuidance = item.message.runtimeGuidance === true;
      // Output items can be reordered or recovered while the same reply streams.
      // Only user boundaries establish another assistant view within a turn.
      if (
        splitsReply &&
        (hadAssistant || followsGuidance || assistantAnchor !== "assistant")
      ) {
        assistantAnchor = `after:${item.id}`;
      }
      if (followsGuidance && turn.id !== null) {
        const block = projectedGuidanceBlock(item.message, turn.id);
        assistantItems.push({ id: block.id, type: "block", block });
      }
      continue;
    }
    if (item.type === "block") {
      // An unloaded parent does not turn a child into root output. The flat
      // canonical items retain it until its parent is available.
      if (
        item.block.parentToolUseId &&
        !nonSubagentParentIds.has(item.block.parentToolUseId)
      )
        continue;
      assistantItems.push({
        ...item,
        block: blocksById.get(item.block.id) ?? item.block,
      });
    } else {
      assistantItems.push(item);
    }
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
