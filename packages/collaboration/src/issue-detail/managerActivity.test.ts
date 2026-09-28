import { describe, expect, it } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import {
  managerActivityPresentation,
  managerAssignments,
} from "./managerActivity";

describe("managerActivityPresentation", () => {
  it("labels a completed manager decision as a review instead of task planning", () => {
    expect(
      managerActivityPresentation(
        createCollaborationTranslator("zh-CN"),
        {},
        "completed",
      ),
    ).toEqual({
      label: "已完成本轮评估",
      planning: false,
    });
  });

  it("projects a cancelled manager run as a terminal stopped event", () => {
    expect(
      managerActivityPresentation(
        createCollaborationTranslator("zh-CN"),
        {},
        "cancelled",
      ),
    ).toEqual({
      label: "已停止任务规划",
      planning: false,
    });
  });

  it("keeps each dispatched task bound to its assignee and workflow stage", () => {
    expect(
      managerAssignments({
        dispatch_assignments: [
          {
            task_title: "采集运行证据",
            agent_name: "诊断智能体",
            workflow_stage_id: "investigation",
          },
          {
            task_title: "独立复核结论",
            human_user_name: "复核成员",
          },
        ],
      }),
    ).toEqual([
      {
        taskTitle: "采集运行证据",
        assigneeName: "诊断智能体",
        workflowStageId: "investigation",
      },
      {
        taskTitle: "独立复核结论",
        assigneeName: "复核成员",
        workflowStageId: null,
      },
    ]);
  });
});
