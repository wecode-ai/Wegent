// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueBoardCardContent } from "./IssueBoardCardContent";
import { createCollaborationTranslator } from "../i18n";

const translate = createCollaborationTranslator("zh-CN");

const display = {
  showAssignee: true,
  showDate: false,
  showPriority: true,
  showTags: true,
};

const labels = {
  assignee: "负责人",
  createdAt: "创建时间",
  priority: {
    none: "普通",
    low: "低",
    medium: "中",
    high: "高",
    urgent: "紧急",
  },
  unassigned: "未指定",
};

const badgeTestId = "cloud-todo-card-needs-execution-config-issue-1";

function render(execution_state?: string | null): string {
  return renderToStaticMarkup(
    <IssueBoardCardContent
      item={{
        id: "issue-1",
        title: "Owner assigned",
        priority: "none",
        execution_state,
      }}
      reference="PRJ-1"
      display={display}
      labels={labels}
      translate={translate}
    />,
  );
}

describe("issue board card execution configuration", () => {
  it("shows the reason a robot-owned Issue is not running", () => {
    const markup = render("waiting_runtime");
    expect(markup).toContain(badgeTestId);
    expect(markup).toContain("待配置");
  });

  it("stays hidden while the latest run is not waiting for a runtime", () => {
    expect(render("running")).not.toContain(badgeTestId);
    expect(render("queued")).not.toContain(badgeTestId);
    expect(render(null)).not.toContain(badgeTestId);
    expect(render(undefined)).not.toContain(badgeTestId);
  });
});
