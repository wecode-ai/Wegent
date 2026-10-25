import { describe, expect, it } from "vitest";
import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from "./runtime-conversation";
import { projectRuntimeConversationTurn } from "./runtime-turn-projection";

const text: RuntimeConversationItem = {
  id: "native-final",
  type: "assistant_text",
  content: "```sql\nSELECT 1;\n```",
  createdAt: "2026-10-21T19:00:00Z",
};
const reasoning: RuntimeConversationItem = {
  id: "native-reasoning",
  type: "block",
  block: {
    id: "native-reasoning",
    type: "thinking",
    content: "Plan",
    createdAt: 1,
  },
};
const turn: RuntimeConversationTurn = {
  id: "turn-1",
  status: "streaming",
  items: [],
};
const project = (items: RuntimeConversationItem[]) =>
  projectRuntimeConversationTurn({ ...turn, items });

describe("assistant view identity", () => {
  it("keeps pre-prompt processing in the same reply when native positions put it before the initial user", () => {
    const compact: RuntimeConversationItem = {
      id: "compact",
      position: 1,
      type: "block",
      block: {
        id: "compact",
        subtaskId: "turn-1",
        type: "tool",
        toolName: "context_compaction",
        status: "done",
        createdAt: 1,
      },
    };
    const user: RuntimeConversationItem = {
      id: "user",
      position: 2,
      type: "user_message",
      message: {
        id: "client-user",
        role: "user",
        content: "Continue",
        status: "done",
        createdAt: "",
      },
    };
    const result = projectRuntimeConversationTurn({
      ...turn,
      status: "done",
      items: [compact, user, text],
    });
    expect(result.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result[1].id).toBe("runtime-view:turn-1:assistant");
    expect(result[1].blocks).toEqual([compact.block]);
    expect(result[1].content).toBe(text.content);
  });
  it("keeps the same view from empty startup through late reasoning and native recovery", () => {
    const initial = project([])[0];
    const streamed = project([
      { ...text, id: "assistant-turn-1" },
      reasoning,
    ])[0];
    const recovered = projectRuntimeConversationTurn({
      ...turn,
      status: "done",
      items: [reasoning, text],
    })[0];

    expect(streamed.id).toBe(initial.id);
    expect(recovered.id).toBe(streamed.id);
    expect(recovered.content).toBe(text.content);
  });

  it("gives each guidance boundary a distinct stable assistant view", () => {
    const guidance: RuntimeConversationItem = {
      id: "guidance-1",
      type: "user_message",
      message: {
        id: "guidance-1",
        role: "user",
        content: "Continue",
        status: "done",
        runtimeGuidance: true,
      },
    };
    const before = project([
      text,
      guidance,
      { ...text, id: "after", content: "After" },
    ]);
    const after = project([
      reasoning,
      text,
      guidance,
      { ...reasoning, id: "later-reasoning" },
      { ...text, id: "after", content: "After" },
    ]);

    expect(before.map((message) => message.id)).toEqual(
      after.map((message) => message.id),
    );
    expect(new Set(before.map((message) => message.id)).size).toBe(3);
    expect(before.map((message) => message.content)).toEqual([
      text.content,
      "Continue",
      "After",
    ]);
  });
});
