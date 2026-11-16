// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createCollaborationTranslator,
  localizeStandardStatuses,
  localizeStandardStatusName,
} from "./i18n";

describe("collaboration i18n", () => {
  it("localizes canonical history names without changing custom or missing status names", () => {
    const en = createCollaborationTranslator("en");
    const zh = createCollaborationTranslator("zh-CN");
    expect(localizeStandardStatusName("inbox", "收集箱", en)).toBe("Inbox");
    expect(localizeStandardStatusName("in_progress", "进行中", en)).toBe(
      "In progress",
    );
    expect(localizeStandardStatusName("in_review", "In review", zh)).toBe(
      "待确认",
    );
    expect(localizeStandardStatusName("pending", "等待设计", en)).toBe(
      "等待设计",
    );
    expect(localizeStandardStatusName("custom", "收集箱", en)).toBe("收集箱");
    expect(localizeStandardStatusName("inbox", null, en)).toBe("");
  });
  it("localizes shared board controls without Chinese fallbacks in English", () => {
    const en = createCollaborationTranslator("en");
    const zh = createCollaborationTranslator("zh-CN");
    expect(en("todo.board_all_groups", undefined, { group: "Status" })).toBe(
      "All Status",
    );
    expect(zh("todo.board_all_groups", undefined, { group: "状态" })).toBe(
      "全部状态",
    );
    const keys = [
      "todo.board_all",
      "todo.board_group_items",
      "todo.board_filter_group",
      "todo.board_issue_unit",
      "todo.board_issue_unit_one",
      "todo.focus_view",
      "todo.focus_view_description",
      "todo.exit_focus_view_description",
    ];
    for (const key of keys) {
      expect(en(key)).not.toBe(key);
      expect(en(key)).not.toMatch(/\p{Script=Han}/u);
      expect(zh(key)).not.toBe(key);
    }
    expect(en("todo.focus_view")).toBe("Focus view");
    expect(en("todo.board_issue_unit_one")).toBe("issue");
    expect(en("todo.board_issue_unit")).toBe("issues");
    expect(zh("todo.focus_view")).toBe("专注视图");
  });

  it("localizes execution duration units with interpolation", () => {
    const english = createCollaborationTranslator("en");
    const chinese = createCollaborationTranslator("zh-CN");
    expect(english("todo.elapsed_minutes", undefined, { count: 7 })).toBe(
      "7 min",
    );
    expect(chinese("todo.elapsed_minutes", undefined, { count: 7 })).toBe(
      "7 分钟",
    );
    expect(english("todo.elapsed_hours", undefined, { count: 2 })).toBe("2 h");
    expect(chinese("todo.elapsed_hours", undefined, { count: 2 })).toBe(
      "2 小时",
    );
    expect(english("todo.elapsed_days", undefined, { count: 1 })).toBe("1 d");
    expect(chinese("todo.elapsed_days", undefined, { count: 1 })).toBe("1 天");
  });

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
      "conversation.thinking.completed",
      "todo.projects_home",
      "todo.files_title",
      "todo.manage_project",
      "todo.project_member_capability",
      "todo.project_member_role",
      "todo.issue_detail",
      "todo.issue_markdown_hint",
      "todo.created_at_short",
      "todo.automation_source",
      "todo.attachment",
      "todo.collaborators",
      "todo.execution_history",
      "todo.deliveries",
    ];
    const english = keys.map((key) => createCollaborationTranslator("en")(key));
    const chinese = keys.map((key) =>
      createCollaborationTranslator("zh-CN")(key),
    );

    expect(english[0]).toBe("Thought process");
    expect(chinese[0]).toBe("思考过程");
    expect(english.join(" ")).not.toMatch(/\p{Script=Han}/u);
    expect(chinese.join(" ")).not.toMatch(/\b(?:conversation|todo|common)\./);
  });

  it("localizes the pending pasted-text attachment status", () => {
    const key = "workbench.adding_pasted_text_attachment";
    expect(createCollaborationTranslator("en")(key)).toBe(
      "Adding pasted text…",
    );
    expect(createCollaborationTranslator("zh-CN")(key)).toBe(
      "正在添加粘贴的文本…",
    );
  });
});
