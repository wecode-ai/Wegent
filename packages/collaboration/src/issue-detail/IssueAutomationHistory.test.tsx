import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createCollaborationTranslator,
  localizeStandardStatusName,
} from "../i18n";
import {
  assignmentHistoryLabels,
  IssueAssignmentHistoryList,
  IssueStatusHistoryList,
} from "./IssueHistoryLists";

const automation = {
  rule_id: "rule-1",
  rule_name: "新事项分析",
  run_id: "run-1",
};
const assignment = {
  by_user_id: 52,
  to_type: "agent" as const,
  to_id: "worker",
  to_name: "项目负责人",
  action: "reassign" as const,
  at: "2026-11-06T11:28:39Z",
};
const status = {
  by_user_id: 52,
  from_status: "pending",
  to_status: "in_progress",
  trigger: "robot_assignment",
  at: assignment.at,
};

describe("automation operation attribution", () => {
  it.each([true, false])(
    "renders assignment source with automation=%s",
    (automated) => {
      const html = renderToStaticMarkup(
        createElement(IssueAssignmentHistoryList, {
          entries: [{ ...assignment, ...(automated ? { automation } : {}) }],
          memberName: () => "User 52",
          labels: assignmentHistoryLabels(createCollaborationTranslator("en")),
        }),
      );
      expect(html).toContain(automated ? automation.rule_name : "User 52");
      expect(html).not.toContain(automated ? "User 52" : automation.rule_name);
      expect(html).toContain("项目负责人");
      expect(html).toContain("Reassign");
    },
  );

  it.each([true, false])(
    "renders status source with automation=%s",
    (automated) => {
      const html = renderToStaticMarkup(
        createElement(IssueStatusHistoryList, {
          entries: [{ ...status, ...(automated ? { automation } : {}) }],
          memberName: () => "User 52",
          labels: {
            system: "System",
            unset: "Unset",
            initial: "Initial",
            accept: "Accept",
            statusName: (id, name) =>
              localizeStandardStatusName(
                id,
                name,
                createCollaborationTranslator("en"),
              ),
            action: () => "Change status",
          },
        }),
      );
      expect(html).toContain(automated ? automation.rule_name : "User 52");
      expect(html).not.toContain(automated ? "User 52" : automation.rule_name);
    },
  );
});
