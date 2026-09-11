// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { formatIssueAttachmentSize } from "./IssueDetailCore";
import {
  issueAssigneeTarget,
  parseIssueAssigneeTarget,
  persistIssueDetailDraft,
} from "./IssueDetailDraft";

describe("IssueDetailCore", () => {
  it("formats attachment sizes consistently for Web and Wework adapters", () => {
    expect(formatIssueAttachmentSize(512)).toBe("512 B");
    expect(formatIssueAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatIssueAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("persists core fields before assigning against the returned version", async () => {
    const issue = { id: "issue-1", version: 1, assignee_user_id: null };
    const updated = { ...issue, version: 2 };
    const assigned = { ...updated, version: 3, assignee_user_id: 5 };
    const update = vi.fn(async () => updated);
    const assign = vi.fn(async () => assigned);

    await expect(
      persistIssueDetailDraft(
        issue,
        {
          title: "共享详情",
          description: "描述",
          status: "pending",
          priority: "high",
          parentId: "",
          dueDate: "",
          tags: [],
          assigneeTarget: "user:5",
          workflow: null,
        },
        false,
        {
          getAssigneeTarget: issueAssigneeTarget,
          update,
          assign,
        },
      ),
    ).resolves.toEqual(assigned);
    expect(update).toHaveBeenCalledWith(
      issue,
      expect.objectContaining({ title: "共享详情", assigneeTarget: "user:5" }),
      {
        assigneeUserId: 5,
        assigneeAgentId: null,
        assigneeTeamId: null,
      },
    );
    expect(assign).toHaveBeenCalledWith(updated, "user:5", false);
  });

  it("normalizes all supported assignee targets", () => {
    expect(parseIssueAssigneeTarget("agent:bot-1")).toEqual({
      assigneeUserId: null,
      assigneeAgentId: "bot-1",
      assigneeTeamId: null,
    });
    expect(parseIssueAssigneeTarget("team:42")).toEqual({
      assigneeUserId: null,
      assigneeAgentId: null,
      assigneeTeamId: 42,
    });
  });
});
