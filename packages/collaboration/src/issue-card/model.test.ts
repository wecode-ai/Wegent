// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createCollaborationIssueCardModel,
  formatIssueCardDueDate,
  resolveIssueCardAssignee,
} from "./model";

const labels = {
  assignee: "Assignee",
  priority: {
    none: "Normal",
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
  },
  unassigned: "Unassigned",
} as const;

describe("collaboration issue card model", () => {
  it("resolves user, team and agent assignees through one precedence rule", () => {
    expect(
      resolveIssueCardAssignee({
        id: "ISSUE-1",
        title: "Issue",
        priority: "none",
        assignee_name: "Ada",
        assignee_team_name: "Platform",
      }),
    ).toEqual({ assigneeKind: "user", assigneeName: "Ada" });
    expect(
      resolveIssueCardAssignee({
        id: "ISSUE-1",
        title: "Issue",
        priority: "none",
        assignee_team_name: "Platform",
      }),
    ).toEqual({ assigneeKind: "team", assigneeName: "Platform" });
    expect(
      resolveIssueCardAssignee(
        {
          id: "ISSUE-1",
          title: "Issue",
          priority: "none",
          assignee_agent_id: "agent-1",
        },
        { "agent-1": "Codex" },
      ),
    ).toEqual({ assigneeKind: "agent", assigneeName: "Codex" });
  });

  it("builds shared reference, priority, tags, unread and due-date display data", () => {
    expect(
      createCollaborationIssueCardModel({
        item: {
          id: "ISSUE-1",
          title: "Share the board card",
          priority: "high",
          due_at: "2026-09-12T03:00:00Z",
          tags: ["frontend"],
          is_unread: true,
        },
        labels,
        reference: "WEG-1",
      }),
    ).toMatchObject({
      dueDate: "2026-09-12",
      priorityLabel: "High",
      reference: "WEG-1",
      tags: ["frontend"],
      title: "Share the board card",
      unread: true,
    });
  });

  it("does not substitute an update timestamp for a missing deadline", () => {
    expect(formatIssueCardDueDate(null)).toBeNull();
  });
});
