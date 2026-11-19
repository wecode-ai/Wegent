import { describe, expect, it } from "vitest";
import type { ProjectChatMessage } from "./project-chat";
import type { RuntimeConversationTurn } from "./runtime-conversation";
import { activityExecutionDisplayStatus } from "./activity-execution-turn";

const message = {
  sender: { type: "agent" },
  metadata: {},
  runtimeAddress: { deviceId: "device", taskId: "runtime-task" },
} as ProjectChatMessage;

describe("activityExecutionDisplayStatus", () => {
  it("preserves a completed comment when its runtime turn is unavailable", () => {
    expect(
      activityExecutionDisplayStatus(
        { ...message, status: "completed" },
        [],
        undefined,
        true,
      ),
    ).toBe("completed");
  });

  it("keeps a durable completed activity above a stale streaming turn", () => {
    const turn = {
      id: "turn-1",
      status: "streaming",
      items: [],
    } as RuntimeConversationTurn;
    expect(
      activityExecutionDisplayStatus(
        { ...message, status: "completed" },
        [turn],
        turn,
        false,
      ),
    ).toBe("completed");
  });

  it("keeps a streaming comment unverified when its runtime is idle", () => {
    expect(
      activityExecutionDisplayStatus(
        { ...message, status: "streaming" },
        [],
        undefined,
        true,
      ),
    ).toBe("unknown");
  });
});
