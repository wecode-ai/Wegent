import { describe, expect, it } from "vitest";
import type { RuntimeConversationTurn } from "./runtime-conversation";
import { mergeRuntimeConversationTurns } from "./runtime-conversation-turns";

const older: RuntimeConversationTurn = {
  id: "older",
  status: "done",
  items: [
    {
      id: "older-text",
      type: "assistant_text",
      content: "older",
      createdAt: "2026-10-20T02:32:26Z",
    },
  ],
};
const latest: RuntimeConversationTurn = {
  id: "latest",
  status: "done",
  items: [
    {
      id: "latest-text",
      type: "assistant_text",
      content: "latest",
      createdAt: "2026-10-20T09:36:48Z",
    },
  ],
};

describe("latest-page reconciliation with itemless historical turns", () => {
  it.each([
    { completedAt: "2026-10-19T01:00:00Z" },
    { completedAt: Date.parse("2026-10-19T01:00:00Z") },
    { startedAt: Date.parse("2026-10-19T01:00:00Z") },
  ])(
    "uses the lifecycle timestamp %j to keep the latest reply last",
    (timestamps) => {
      const failed: RuntimeConversationTurn = {
        id: "failed",
        status: "failed",
        items: [],
        error: "The request failed before producing any items",
        ...timestamps,
      };

      expect(
        mergeRuntimeConversationTurns([failed, older, latest], [latest]).map(
          (turn) => turn.id,
        ),
      ).toEqual(["failed", "older", "latest"]);
    },
  );
});

describe("native positions mixed with streamed turns", () => {
  const streamed = (id: string): RuntimeConversationTurn => ({
    id,
    status: "streaming",
    items: [{ id: `${id}-text`, type: "assistant_text", content: id }],
  });

  it("keeps earlier streamed goal turns before a positioned latest page", () => {
    const local = [
      { ...streamed("initial"), position: 1 },
      streamed("continued-1"),
      streamed("continued-2"),
      streamed("continued-3"),
      streamed("latest"),
    ];
    const page = [
      { ...streamed("continued-3"), position: 40 },
      { ...streamed("latest"), position: 50 },
    ];
    const merged = mergeRuntimeConversationTurns(local, page);
    expect(merged.map((turn) => turn.id)).toEqual(local.map((turn) => turn.id));
    expect(merged.at(-1)?.items[0]).toMatchObject({ content: "latest" });
    expect(
      merged
        .filter((turn) => turn.position !== undefined)
        .map((turn) => turn.position),
    ).toEqual([1, 40, 50]);
    expect(
      mergeRuntimeConversationTurns(merged, page).map((turn) => turn.id),
    ).toEqual(local.map((turn) => turn.id));
  });

  it("retains a live tail after native history, even when history inserts unseen turns", () => {
    const local = [streamed("known"), streamed("live")];
    const page = [
      { ...streamed("known"), position: 10 },
      { ...streamed("discovered"), position: 20 },
    ];
    expect(
      mergeRuntimeConversationTurns(local, page).map((turn) => turn.id),
    ).toEqual(["known", "discovered", "live"]);
  });

  it("keeps observed neighbors when native identity reconciles a streamed turn alias", () => {
    const alias = streamed("alias");
    const local = [streamed("gap"), alias];
    const page = [{ ...alias, id: "native", position: 30 }];
    expect(
      mergeRuntimeConversationTurns(local, page).map((turn) => turn.id),
    ).toEqual(["gap", "native"]);
  });

  it("uses native positions to correct positioned turns without moving an observed gap to the tail", () => {
    const local = [streamed("first"), streamed("gap"), streamed("last")];
    const page = [
      { ...streamed("first"), position: 10 },
      { ...streamed("last"), position: 30 },
    ];
    expect(
      mergeRuntimeConversationTurns(local, page).map((turn) => turn.id),
    ).toEqual(["first", "gap", "last"]);
  });
});
