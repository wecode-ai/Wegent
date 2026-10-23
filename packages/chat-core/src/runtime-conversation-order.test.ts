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
  it("retires provisional stream history before a confirmed native boundary instead of appending it after 500 items", () => {
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
    ).toEqual([...snapshot.map((item) => item.id), "unfinished"]);
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
