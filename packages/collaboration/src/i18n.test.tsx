// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createCollaborationTranslator,
  localizeStandardStatuses,
} from "./i18n";

describe("collaboration i18n", () => {
  it("localizes only the complete standard status set by stable id", () => {
    const standard = [
      { id: "inbox", name: "收集箱" },
      { id: "pending", name: "待开始" },
      { id: "in_progress", name: "进行中" },
      { id: "in_review", name: "待确认" },
      { id: "completed", name: "已完成" },
    ];
    expect(
      localizeStandardStatuses(
        standard,
        createCollaborationTranslator("en"),
      ).map((status) => status.name),
    ).toEqual(["Inbox", "To do", "In progress", "In review", "Completed"]);

    const customized = standard.map((status) =>
      status.id === "pending"
        ? { ...status, name: "Ready for design" }
        : status,
    );
    expect(
      localizeStandardStatuses(customized, createCollaborationTranslator("en")),
    ).toEqual(customized);
  });

  it("resolves core English and Chinese keys without leaking raw keys", () => {
    const keys = [
      "todo.projects_home",
      "todo.files_title",
      "todo.manage_project",
      "todo.issue_detail",
      "todo.attachment",
      "todo.collaborators",
      "todo.execution_history",
      "todo.deliveries",
      "todo.workflow_stage_human_execution",
      "todo.workflow_node_completed",
      "todo.workflow_task_count",
    ];
    const english = keys.map((key) => createCollaborationTranslator("en")(key));
    const chinese = keys.map((key) =>
      createCollaborationTranslator("zh-CN")(key),
    );

    expect(english.join(" ")).not.toMatch(/\p{Script=Han}/u);
    expect(chinese.join(" ")).not.toMatch(/\b(?:todo|common)\./);
  });
});
