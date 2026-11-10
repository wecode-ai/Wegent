import { expect, test } from "vitest";
import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from "./runtime-conversation";
import { projectRuntimeConversationTurns } from "./runtime-turns";
import { nestWorkbenchProcessingBlocks } from "./workbench-message-reducer";

const parent: RuntimeConversationItem = {
  id: "subagent-worker",
  type: "block",
  block: {
    id: "subagent-worker",
    type: "subagent",
    agentThreadId: "worker",
    status: "streaming",
    createdAt: 1,
  },
};
const guidance: RuntimeConversationItem = {
  id: "guidance",
  type: "user_message",
  message: {
    id: "guidance",
    role: "user",
    runtimeGuidance: true,
    content: "Continue investigating",
    status: "done",
    createdAt: "2026-11-10T14:40:00Z",
  },
};
const children: RuntimeConversationItem[] = ["text", "thinking", "tool"].map(
  (type) => ({
    id: `child-${type}`,
    type: "block",
    block: {
      id: `child-${type}`,
      parentToolUseId: "subagent-worker",
      createdAt: 2,
      status: "streaming",
      ...(type === "tool"
        ? { type: "tool", toolName: "shell", toolOutput: "child tool output" }
        : {
            type: type as "text" | "thinking",
            content: `child ${type} output`,
          }),
    },
  }),
);
const reply: RuntimeConversationItem = {
  id: "root-reply",
  type: "assistant_text",
  content: "Root reply",
  createdAt: "2026-11-10T14:42:00Z",
};
const turn = (
  id: string,
  items: RuntimeConversationItem[],
): RuntimeConversationTurn => ({
  id,
  status: "streaming",
  items,
});

test.each(["same turn", "next turn"])(
  "keeps late child output with its parent across %s guidance",
  (boundary) => {
    const turns =
      boundary === "same turn"
        ? [turn("root", [parent, guidance, ...children, reply])]
        : [
            turn("root", [parent]),
            turn("next", [guidance, ...children, reply]),
          ];
    const messages = projectRuntimeConversationTurns(turns);
    const blocks = messages.flatMap((message) =>
      nestWorkbenchProcessingBlocks(message.blocks ?? []),
    );

    expect(blocks.filter((block) => block.id.startsWith("child-"))).toEqual([]);
    expect(blocks.find((block) => block.type === "subagent")).toMatchObject({
      id: "subagent-worker",
      children: children.map((item) =>
        expect.objectContaining({ id: item.id }),
      ),
    });
    expect(
      messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Continue investigating"]);
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join(""),
    ).toBe("Root reply");
    expect(
      turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.id.startsWith("child-")),
    ).toEqual(children);
  },
);

test("retains unattached child data without promoting it to root output while its parent loads", () => {
  const pending = [turn("root", children)];
  expect(
    projectRuntimeConversationTurns(pending).flatMap(
      (message) => message.blocks ?? [],
    ),
  ).toEqual([]);
  const loaded = projectRuntimeConversationTurns([
    turn("root", [parent, ...children]),
  ]);
  expect(loaded[0].blocks?.[0]).toMatchObject({
    id: "subagent-worker",
    children: children.map((item) => expect.objectContaining({ id: item.id })),
  });
  expect(pending[0].items).toEqual(children);
});

test("uses the block identity when a transcript item has a separate identity", () => {
  const messages = projectRuntimeConversationTurns([
    turn("root", [
      { ...parent, id: "transcript-parent" },
      guidance,
      ...children,
    ]),
  ]);
  expect(messages[0].blocks?.[0]).toMatchObject({
    id: "subagent-worker",
    children: children.map((item) => expect.objectContaining({ id: item.id })),
  });
  expect(
    parent.type === "block" &&
      parent.block.type === "subagent" &&
      parent.block.children,
  ).toBeUndefined();
});

test("keeps unrelated root blocks scoped to their original turns", () => {
  const block = (content: string): RuntimeConversationItem => ({
    id: "reused-id",
    type: "block",
    block: { id: "reused-id", type: "text", content, createdAt: 1 },
  });
  const messages = projectRuntimeConversationTurns([
    turn("first", [block("first")]),
    turn("second", [block("second")]),
  ]);
  expect(messages.map((message) => message.blocks?.[0])).toMatchObject([
    { content: "first" },
    { content: "second" },
  ]);
});
