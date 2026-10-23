import { appendAcceptedRuntimeConversationUser } from "./runtime-turn-updates";
import { projectRuntimePaneTranscript } from "./runtime-transcript-page";
import { describe, expect, it } from "vitest";
import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from "./runtime-conversation";
import {
  hydrateRuntimeConversationTurns,
  mergeRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from "./runtime-conversation-turns";

const item = (id: string, position: number): RuntimeConversationItem => ({
  id,
  position,
  type: "assistant_text",
  content: "Repeated progress",
  createdAt: "2026-10-23T00:00:00Z",
});
const turn = (items: RuntimeConversationItem[]): RuntimeConversationTurn => ({
  id: "turn",
  status: "streaming",
  items,
});
const ids = (turns: RuntimeConversationTurn[]) =>
  turns[0].items.map((item) => item.id);

describe("native conversation ordering contract", () => {
  it("keeps the legacy display adapter when a page carries assistant output without native turns", () => {
    const page = projectRuntimePaneTranscript({
      runtime: "codex",
      workspacePath: "/repo",
      turns: [],
      runtimeTurns: [],
      messages: [
        { id: "legacy-user", role: "user", content: "Prompt" },
        { id: "legacy-assistant", role: "assistant", content: "Answer" },
      ],
    });
    expect(page.messages.map((message) => message.content)).toEqual([
      "Prompt",
      "Answer",
    ]);
    expect(page.turns).toEqual([]);
  });

  it("does not invent an observed boundary when a native user first arrives after live output", () => {
    const live = turn([
      {
        id: "reply",
        type: "assistant_text",
        content: "Partial",
        createdAt: "",
      },
    ]);
    const native = turn([
      {
        id: "native-user",
        position: 1,
        type: "user_message",
        message: {
          id: "native-user",
          role: "user",
          content: "Prompt",
          status: "done",
          createdAt: "",
        },
      },
    ]);
    expect(ids(mergeRuntimeConversationTurns([live], [native]))).toEqual([
      "native-user",
      "reply",
    ]);
  });

  it("materializes the accepted user when turn start supplied only its identity", () => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: "started",
        clientUserMessageId: "client-user",
        status: "streaming",
        items: [],
      },
    ];
    const accepted = appendAcceptedRuntimeConversationUser(
      turns,
      {
        id: "client-user",
        role: "user",
        content: "Queued prompt",
        status: "done",
        createdAt: "",
      },
      "started",
      new Set(),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].items).toMatchObject([
      {
        type: "user_message",
        message: {
          id: "client-user",
          turnId: "started",
          content: "Queued prompt",
        },
      },
    ]);
  });

  it("recognizes a late send acknowledgement through the explicit native user alias", () => {
    const page = projectRuntimePaneTranscript({
      runtime: "codex",
      workspacePath: "/repo",
      messages: [],
      turns: [
        {
          id: "completed",
          status: "completed",
          items: [
            {
              id: "native-user",
              type: "user_message",
              position: 10,
              message: {
                id: "native-user",
                clientUserMessageId: "client-user",
                role: "user",
                content: "Continue",
              },
            },
            {
              id: "answer",
              type: "assistant_text",
              position: 11,
              content: "Finished",
            },
          ],
        },
      ],
    });
    const accepted = appendAcceptedRuntimeConversationUser(
      page.turns,
      {
        id: "client-user",
        role: "user",
        status: "done",
        content: "Continue",
        createdAt: "",
      },
      null,
      new Set(),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].items.map((item) => item.id)).toEqual([
      "native-user",
      "answer",
    ]);
  });
  it("projects a newly streaming reply after its persisted user before any assistant identity is shared", () => {
    const page = projectRuntimePaneTranscript({
      runtime: "codex",
      workspacePath: "/repo",
      messages: [],
      running: true,
      turns: [
        {
          id: "current",
          status: "inProgress",
          position: 10,
          items: [
            {
              id: "native-user",
              type: "user_message",
              position: 11,
              message: { id: "native-user", role: "user", content: "Prompt" },
            },
          ],
        },
      ],
      runtimeTurns: [
        {
          id: "current",
          status: "streaming",
          items: [
            { id: "reply", type: "assistant_text", content: "Partial answer" },
          ],
        },
      ],
    });
    expect(page.turns[0].items.map((item) => item.id)).toEqual([
      "native-user",
      "reply",
    ]);
    expect(
      page.messages.map((message) => [
        message.role,
        message.content,
        message.status,
      ]),
    ).toEqual([
      ["user", "Prompt", "done"],
      ["assistant", "Partial answer", "streaming"],
    ]);
  });
  it("preserves a presentation-only legacy preview with an empty native page", () => {
    const page = projectRuntimePaneTranscript({
      runtime: "codex",
      workspacePath: "/repo",
      turns: [],
      runtimeTurns: [],
      messages: [
        { id: "legacy-preview", role: "user", content: "Original prompt" },
      ],
    });
    expect(page.messages.map((message) => message.content)).toEqual([
      "Original prompt",
    ]);
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]).toMatchObject({ id: null, status: "done" });
    expect(page.turns[0].items[0]).toMatchObject({
      type: "user_message",
      message: { content: "Original prompt" },
    });
  });
  it("preserves a legacy display projection when the remote schema returns no runtime overlay", () => {
    const page = projectRuntimePaneTranscript({
      runtime: "claude_code",
      workspacePath: "/repo",
      runtimeTurns: null,
      turns: [],
      messages: [
        { id: "legacy", role: "assistant", content: "Legacy display" },
      ],
    });
    expect(page.messages[0].content).toBe("Legacy display");
  });
  it("keeps pending runtime blocks omitted by durable history and only deletes explicit superseded turns", () => {
    const command: RuntimeConversationItem = {
      id: "background",
      type: "block",
      block: {
        id: "background",
        type: "tool",
        subtaskId: "turn",
        toolName: "exec_command",
        createdAt: 1,
        status: "streaming",
        renderPayload: { kind: "command_execution", status: "inProgress" },
      },
    };
    const snapshot = { ...turn([item("final", 20)]), status: "done" as const };
    const local = { ...snapshot, items: [command, item("final", 20)] };
    expect(
      ids(hydrateRuntimeConversationTurns([local], [snapshot], [])),
    ).toEqual(["background", "final"]);
    expect(
      hydrateRuntimeConversationTurns([local], [], [], true, ["turn"]),
    ).toEqual([]);
  });

  it("joins the native user identity to its explicit client alias without duplicating the prompt", () => {
    const message = {
      id: "client-user",
      role: "user" as const,
      content: "Prompt",
      status: "done" as const,
      createdAt: "",
    };
    const local: RuntimeConversationItem = {
      id: "client-user",
      type: "user_message",
      message,
    };
    const native: RuntimeConversationItem = {
      id: "native-user",
      type: "user_message",
      message,
      position: 1,
    };
    expect(
      ids(mergeRuntimeConversationTurns([turn([local])], [turn([native])])),
    ).toEqual(["native-user"]);
  });
  it("keeps unpersisted runtime items beside their observed native boundary across 500-item pages", () => {
    const provisional = Array.from({ length: 520 }, (_, index) => ({
      ...item(`item-${index}`, index),
      position: undefined,
    }));
    const snapshot = Array.from({ length: 500 }, (_, index) =>
      item(`item-${index + 20}`, index + 20),
    );
    const tail = { ...item("unfinished", 520), position: undefined };
    expect(
      ids(
        mergeRuntimeConversationTurns(
          [turn([...provisional, tail])],
          [turn(snapshot)],
        ),
      ),
    ).toEqual([...provisional.map((item) => item.id), "unfinished"]);
  });
  it("does not append a tool delta twice when native history already persisted it", () => {
    const tool = (output: string): RuntimeConversationTurn =>
      turn([
        {
          id: "command",
          position: 10,
          type: "block",
          block: {
            id: "command",
            subtaskId: "turn",
            type: "tool",
            toolName: "exec_command",
            status: "streaming",
            createdAt: 1,
            toolOutput: output,
            renderPayload: { kind: "command_execution", status: "inProgress" },
          },
        },
      ]);
    const result = hydrateRuntimeConversationTurns(
      [tool("first\n")],
      [tool("first\nsecond\n")],
      [
        {
          type: "block_updated",
          subtaskId: "turn",
          blockId: "command",
          updates: { toolOutputDelta: "second\n" },
        },
      ],
    );
    const item = result[0].items[0];
    expect(
      item.type === "block" &&
        item.block.type === "tool" &&
        item.block.toolOutput,
    ).toBe("first\nsecond\n");
  });
  it("repairs the recorded old-message insertion even when every item already exists", () => {
    const older = item("older-recovery", 3313);
    const recent = [
      item("ci-65", 4901),
      item("ci-70", 4923),
      item("ci-73", 4945),
    ];
    const latest = item("ci-75", 4982);
    const local = turn([...recent, older, latest]);
    expect(
      ids(
        mergeRuntimeConversationTurns(
          [local],
          [turn([older, ...recent, latest])],
        ),
      ),
    ).toEqual(["older-recovery", "ci-65", "ci-70", "ci-73", "ci-75"]);
  });

  it("converges for overlapping pages, duplicate reads and every arrival permutation", () => {
    const pages = [
      turn([item("a", 10), item("b", 20)]),
      turn([item("b", 20), item("c", 30)]),
      turn([item("d", 40)]),
    ];
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      let turns: RuntimeConversationTurn[] = [];
      for (const index of [...order, ...order])
        turns = mergeRuntimeConversationTurns(turns, [pages[index]]);
      expect(ids(turns)).toEqual(["a", "b", "c", "d"]);
    }
  });

  it("keeps distinct native identities when their content and timestamps match", () => {
    expect(
      ids(
        mergeRuntimeConversationTurns(
          [turn([item("a", 1)])],
          [turn([item("b", 2)])],
        ),
      ),
    ).toEqual(["a", "b"]);
  });

  it("replays newer live text after committing an older native snapshot", () => {
    const snapshot = turn([{ ...item("text", 10), content: "Old" }]);
    const turns = hydrateRuntimeConversationTurns(
      [],
      [snapshot],
      [
        {
          type: "assistant_chunk",
          subtaskId: "turn",
          itemId: "text",
          content: "New output",
          contentMode: "snapshot",
        },
      ],
    );
    expect(turns[0].items[0]).toMatchObject({
      id: "text",
      position: 10,
      content: "New output",
    });
  });

  it("retains a tool position across live updates and preserves confirmed history around it", () => {
    const tool: RuntimeConversationItem = {
      id: "tool",
      position: 20,
      type: "block",
      block: {
        id: "tool",
        subtaskId: "turn",
        type: "tool",
        toolName: "exec_command",
        status: "streaming",
        createdAt: 1,
      },
    };
    const turns = reduceRuntimeConversationTurns(
      [turn([item("before", 10), tool, item("after", 30)])],
      {
        type: "block_created",
        subtaskId: "turn",
        block: { ...tool.block, status: "done" },
      },
    );
    expect(turns[0].items.find((item) => item.id === "tool")?.position).toBe(
      20,
    );
    expect(ids(turns)).toEqual(["before", "tool", "after"]);
  });

  it("does not evict loaded native history when the next live item arrives", () => {
    const history: RuntimeConversationItem[] = Array.from(
      { length: 510 },
      (_, index) => ({
        id: `history-${index}`,
        position: index,
        type: "block",
        block: {
          id: `history-${index}`,
          subtaskId: "turn",
          type: "text",
          content: `Progress ${index}`,
          status: "done",
          createdAt: 1,
        },
      }),
    );
    const turns = reduceRuntimeConversationTurns([turn(history)], {
      type: "block_created",
      subtaskId: "turn",
      block: {
        id: "live",
        subtaskId: "turn",
        type: "text",
        content: "Newest",
        status: "streaming",
        createdAt: 2,
      },
    });
    expect(turns[0].items).toHaveLength(511);
    expect(turns[0].items[0].id).toBe("history-0");
    expect(turns[0].contentTruncated).not.toBe(true);
  });
});
