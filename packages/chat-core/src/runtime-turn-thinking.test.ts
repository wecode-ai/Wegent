import { describe, expect, it } from "vitest";
import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from "./runtime-conversation";
import { mergeRuntimeConversationTurns } from "./runtime-conversation-turns";
import { resolveRuntimeTurnThinkingContent } from "./runtime-turn-helpers";

const thinking = {
  id: "reasoning",
  type: "block",
  block: {
    id: "reasoning",
    subtaskId: "turn-1",
    type: "thinking",
    content: "Inspecting the command output",
    status: "done",
    createdAt: 1,
  },
} satisfies RuntimeConversationItem;
const processText = {
  id: "preamble",
  type: "block",
  block: {
    id: "preamble",
    subtaskId: "turn-1",
    type: "text",
    content: "I will inspect the output.",
    status: "done",
    createdAt: 2,
  },
} satisfies RuntimeConversationItem;
const tool = {
  id: "command",
  type: "block",
  block: {
    id: "command",
    subtaskId: "turn-1",
    type: "tool",
    toolName: "exec_command",
    status: "done",
    createdAt: 3,
  },
} satisfies RuntimeConversationItem;
const finalText = {
  id: "answer",
  type: "assistant_text",
  content: "The command completed.",
  createdAt: "2026-10-22T00:00:00Z",
} satisfies RuntimeConversationItem;
const plan = {
  id: "plan",
  type: "block",
  block: {
    id: "plan",
    subtaskId: "turn-1",
    type: "plan",
    content: "",
    status: "done",
    createdAt: 4,
  },
} satisfies RuntimeConversationItem;
const heldItems = [thinking, processText, tool];
const turn = (
  items: RuntimeConversationItem[] = heldItems,
): RuntimeConversationTurn => ({
  id: "turn-1",
  status: "streaming",
  items,
});

describe("native streaming thinking normalization", () => {
  it("restores a completed reasoning summary while waiting after a tool", () => {
    expect(resolveRuntimeTurnThinkingContent(turn())).toBe(
      "Inspecting the command output",
    );
  });

  it.each([
    {
      ...processText,
      id: "later-text",
      block: { ...processText.block, id: "later-text" },
    },
    plan,
    finalText,
  ])("clears the summary when $id follows the tool", (item) => {
    expect(
      resolveRuntimeTurnThinkingContent(turn([...heldItems, item])),
    ).toBeUndefined();
  });

  it.each(["pending", "done", "failed", "cancelled"] as const)(
    "does not restore a summary for a %s turn",
    (status) => {
      expect(
        resolveRuntimeTurnThinkingContent({ ...turn(), status }),
      ).toBeUndefined();
    },
  );

  it("does not invent a summary for a tool without nonempty reasoning", () => {
    expect(resolveRuntimeTurnThinkingContent(turn([tool]))).toBeUndefined();
    const emptyReasoning: RuntimeConversationItem = {
      ...thinking,
      block: { ...thinking.block, content: "   " },
    };
    expect(
      resolveRuntimeTurnThinkingContent(turn([emptyReasoning, tool])),
    ).toBeUndefined();
  });

  it("uses the newest nonempty reasoning before a tool continuation", () => {
    const newer: RuntimeConversationItem = {
      ...thinking,
      id: "new-reasoning",
      block: {
        ...thinking.block,
        id: "new-reasoning",
        content: "Checking the result",
      },
    };
    const nextTool: RuntimeConversationItem = {
      ...tool,
      id: "next-command",
      block: { ...tool.block, id: "next-command" },
    };
    expect(
      resolveRuntimeTurnThinkingContent(turn([...heldItems, newer, nextTool])),
    ).toBe("Checking the result");
  });

  it("preserves the active summary when guidance is appended to the same turn", () => {
    const guidance: RuntimeConversationItem = {
      id: "guidance",
      type: "user_message",
      message: {
        id: "guidance",
        role: "user",
        content: "Inspect the next result.",
        status: "done",
        runtimeGuidance: true,
        createdAt: "2026-10-22T00:00:00Z",
      },
    };
    expect(
      resolveRuntimeTurnThinkingContent(turn([...heldItems, guidance])),
    ).toBe("Inspecting the command output");
  });

  it("keeps a newer text boundary when an older item page is prepended", () => {
    const local = turn([...heldItems, finalText]);
    const older = { ...turn([thinking]), itemMerge: "prepend" as const };
    const [merged] = mergeRuntimeConversationTurns([local], [older]);

    expect(merged.items.map((item) => item.id)).toEqual([
      "reasoning",
      "preamble",
      "command",
      "answer",
    ]);
    expect(merged.streamingThinkingContent).toBeUndefined();
  });

  it.each([finalText, plan])(
    "uses native positions to clear the summary when a prepended page contains $id",
    (boundary) => {
      const local = turn([
        { ...thinking, position: 1 },
        { ...tool, position: 2 },
      ]);
      const page = {
        ...turn([{ ...boundary, position: 3 }]),
        itemMerge: "prepend" as const,
      };
      const [merged] = mergeRuntimeConversationTurns([local], [page]);

      expect(merged.items.map((item) => item.id)).toEqual([
        "reasoning",
        "command",
        boundary.id,
      ]);
      expect(merged.streamingThinkingContent).toBeUndefined();
    },
  );

  it.each(["done", "failed", "cancelled"] as const)(
    "keeps a local %s turn terminal when a streaming snapshot arrives",
    (status) => {
      const [merged] = mergeRuntimeConversationTurns(
        [{ ...turn(), status }],
        [turn()],
      );

      expect(merged.status).toBe(status);
      expect(merged.streamingThinkingContent).toBeUndefined();
    },
  );
});
