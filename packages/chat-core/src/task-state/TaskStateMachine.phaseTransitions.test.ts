// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { TaskStateMachine } from "..";

describe("Codex message phase changes", () => {
  it("updates the same streamed text block when a completed commentary item arrives", () => {
    const machine = new TaskStateMachine(100, {
      joinTask: vi.fn(),
      isConnected: () => true,
    });
    machine.handleChatStart(42, "Codex", 7);
    machine.handleChatChunk(42, "检查🙂", undefined, undefined, "msg-one", 0);
    machine.handleChatChunk(42, "中", undefined, undefined, "msg-one", 3);
    machine.handleChatChunk(42, "检查🙂中", undefined, undefined, "msg-one", 0);
    machine.handleChatBlockUpdated(42, {
      id: "msg-one",
      type: "text",
      content: "检查🙂中",
      status: "done",
    });
    machine.handleChatChunk(42, "检查🙂中", undefined, undefined, "msg-two", 4);
    const blocks =
      machine.getState().messages.get("ai-42")?.result?.blocks ?? [];
    expect(blocks.map((block) => block.id)).toEqual(["msg-one", "msg-two"]);
    expect(blocks).toMatchObject([
      { type: "text", content: "检查🙂中", status: "done" },
      { type: "text", content: "检查🙂中", status: "streaming" },
    ]);
  });
});
