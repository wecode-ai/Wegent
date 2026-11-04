import { describe, expect, test } from "vitest";
import type {
  RuntimeConversationTurn,
  RuntimePaneMessageAction,
} from "./runtime-conversation";
import {
  hydrateRuntimeConversationTurns,
  mergeRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
} from "./runtime-conversation-turns";

function runningCommand(): RuntimeConversationTurn {
  return {
    id: "turn",
    status: "streaming",
    items: [
      {
        id: "command",
        type: "block",
        block: {
          id: "command",
          type: "tool",
          toolName: "exec_command",
          status: "pending",
          createdAt: 100,
          toolInput: { command: "pwd" },
          renderPayload: {
            kind: "command_execution",
            processId: "process",
            status: "inProgress",
          },
        },
      },
    ],
  };
}

const completed = (status: "done" | "error"): RuntimePaneMessageAction => ({
  type: "block_updated",
  subtaskId: "turn",
  blockId: "command",
  updates: {
    status,
    completedAt: 120,
    durationMs: 20,
    toolOutput: "/workspace\n",
    renderPayload: {
      kind: "command_execution",
      processId: "process",
      status: status === "done" ? "completed" : "failed",
      exitCode: status === "done" ? 0 : 1,
    },
  },
});

function expectCompleted(
  turn: RuntimeConversationTurn,
  status: "done" | "error",
) {
  expect(turn.status).toBe("streaming");
  expect(turn.items[0]).toMatchObject({
    type: "block",
    block: {
      status,
      createdAt: 100,
      completedAt: 120,
      durationMs: 20,
      toolOutput: "/workspace\n",
      renderPayload: {
        processId: "process",
        status: status === "done" ? "completed" : "failed",
        exitCode: status === "done" ? 0 : 1,
      },
    },
  });
}

describe("command completion during an active turn", () => {
  test.each([
    ["done", false],
    ["done", true],
    ["error", false],
    ["error", true],
  ] as const)(
    "keeps native %s over a stale active-turn transcript (applied: %s)",
    (status, applied) => {
      const snapshot = runningCommand();
      const action = completed(status);
      const local = applied
        ? reduceRuntimeConversationTurns([snapshot], action)
        : [snapshot];
      const result = hydrateRuntimeConversationTurns(
        local,
        [snapshot],
        [action],
        applied,
      );
      expectCompleted(result[0], status);
    },
  );

  test("keeps completion over a later block-created copy of the same command", () => {
    const snapshot = runningCommand();
    const local = reduceRuntimeConversationTurns([snapshot], completed("done"));
    const stale = snapshot.items[0];
    if (stale.type !== "block") throw new Error("Expected command fixture");
    const result = reduceRuntimeConversationTurns(local, {
      type: "block_created",
      subtaskId: "turn",
      block: stale.block,
    });
    expectCompleted(result[0], "done");
  });

  test("accepts a completed native snapshot while the command is still running locally", () => {
    const local = [runningCommand()];
    const snapshot = reduceRuntimeConversationTurns(local, completed("done"));
    expectCompleted(mergeRuntimeConversationTurns(local, snapshot)[0], "done");
  });

  test("does not mark a background process complete when only the turn finishes", () => {
    const result = hydrateRuntimeConversationTurns(
      [runningCommand()],
      [{ ...runningCommand(), status: "done" }],
      [],
    );
    expect(result[0].status).toBe("done");
    expect(result[0].items[0]).toMatchObject({
      block: { status: "pending", renderPayload: { status: "inProgress" } },
    });
  });
});
