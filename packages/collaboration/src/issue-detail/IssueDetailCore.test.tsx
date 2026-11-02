// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { formatIssueAttachmentSize } from "./IssueDetailCore";
import {
  issueAssigneeTarget,
  parseIssueAssigneeTarget,
} from "./IssueDetailDraft";

describe("IssueDetailCore", () => {
  it("retains the local user with ID zero when opening an Issue", () => {
    expect(issueAssigneeTarget({ assignee_user_id: 0 })).toBe("user:0");
    expect(issueAssigneeTarget({ assignee_user_id: null })).toBe("");
    expect(parseIssueAssigneeTarget("user:0")).toEqual({
      assigneeUserId: 0,
      assigneeAgentId: null,
      assigneeTeamId: null,
    });
  });
  it("retains collaboration group ownership when opening an Issue", () => {
    expect(issueAssigneeTarget({ assignee_group_id: "squad-1" })).toBe(
      "group:squad-1",
    );
    expect(parseIssueAssigneeTarget("group:squad-1")).toEqual({
      assigneeUserId: null,
      assigneeAgentId: null,
      assigneeTeamId: null,
      assigneeGroupId: "squad-1",
    });
  });
  it("formats attachment sizes consistently for Web and Wework adapters", () => {
    expect(formatIssueAttachmentSize(512)).toBe("512 B");
    expect(formatIssueAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatIssueAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
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
