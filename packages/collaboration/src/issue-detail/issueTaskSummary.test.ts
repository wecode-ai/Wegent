import type { ProjectChatMessage } from "@wegent/chat-core";
import { describe, expect, it } from "vitest";
import { issueTaskSummaryForMessage } from "./issueTaskSummary";

const message = (
  metadata: ProjectChatMessage["metadata"],
): ProjectChatMessage => ({
  messageId: "message",
  projectId: "project",
  taskId: "issue",
  sequenceNumber: 1,
  sender: { type: "agent", id: "worker", name: "Worker" },
  type: "text",
  content: "Done",
  metadata,
  status: "completed",
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
});

describe("issueTaskSummaryForMessage", () => {
  it("uses the persisted workflow task title before a runtime binding is visible", () => {
    expect(
      issueTaskSummaryForMessage(
        message({
          dispatch_role: "executor",
          dispatch_task_id: "execute",
          dispatch_task_title: "检查当前设备磁盘空间",
        }),
        [],
        "看看磁盘",
        undefined,
      ),
    ).toEqual({
      title: "检查当前设备磁盘空间",
      stageName: null,
      onOpen: undefined,
    });
  });

  it("keeps the manager-assigned title when the runtime binds to the parent Issue", () => {
    expect(
      issueTaskSummaryForMessage(
        {
          ...message({
            dispatch_role: "executor",
            dispatch_task_title: "Initial title",
          }),
          runtimeAddress: { deviceId: "device", taskId: "task" },
        },
        [
          {
            device_id: "device",
            task_id: "task",
            task_title: "Updated title",
          },
        ],
        "Issue title",
        undefined,
      )?.title,
    ).toBe("Initial title");
  });

  it("does not replace a missing assigned task title with the Issue title", () => {
    expect(
      issueTaskSummaryForMessage(
        {
          ...message({ dispatch_role: "executor" }),
          runtimeAddress: { deviceId: "device", taskId: "task" },
        },
        [{ device_id: "device", task_id: "task", task_title: null }],
        "Issue title",
        undefined,
      ),
    ).toBeUndefined();
  });
});
