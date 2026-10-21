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
