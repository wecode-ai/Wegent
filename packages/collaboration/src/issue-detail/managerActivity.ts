import type { CollaborationTranslate } from "../i18n";

export interface ManagerAssignment {
  assigneeName: string;
  taskTitle: string;
  workflowStageId: string | null;
}

export function managerAssignments(
  metadata: Record<string, unknown>,
): ManagerAssignment[] {
  if (!Array.isArray(metadata.dispatch_assignments)) return [];
  return metadata.dispatch_assignments.flatMap((assignment) => {
    if (typeof assignment !== "object" || assignment === null) return [];
    const values = assignment as Record<string, unknown>;
    const assigneeName = values.agent_name ?? values.human_user_name;
    const taskTitle = values.task_title;
    if (
      typeof assigneeName !== "string" ||
      !assigneeName.trim() ||
      typeof taskTitle !== "string" ||
      !taskTitle.trim()
    ) {
      return [];
    }
    const workflowStageId =
      typeof values.workflow_stage_id === "string" &&
      values.workflow_stage_id.trim()
        ? values.workflow_stage_id.trim()
        : null;
    return [
      {
        assigneeName: assigneeName.trim(),
        taskTitle: taskTitle.trim(),
        workflowStageId,
      },
    ];
  });
}

export function managerActivityPresentation(
  translate: CollaborationTranslate,
  metadata: Record<string, unknown>,
  state: "running" | "completed" | "failed" | "cancelled",
): { label: string; planning: boolean } {
  if (state === "failed") {
    return {
      label: translate("activity.task_activity_manager_failed"),
      planning: false,
    };
  }
  if (state === "cancelled") {
    return {
      label: translate("activity.task_activity_manager_cancelled"),
      planning: false,
    };
  }
  const assignments = managerAssignments(metadata);
  if (assignments.length) {
    return {
      label: translate("activity.task_activity_manager_dispatched", undefined, {
        assignments: assignments
          .map(
            ({ assigneeName, taskTitle, workflowStageId }) =>
              `${taskTitle} → ${assigneeName}${
                workflowStageId ? ` · ${workflowStageId}` : ""
              }`,
          )
          .join("；"),
      }),
      planning: false,
    };
  }
  return {
    label: translate(
      state === "completed"
        ? "activity.task_activity_manager_planned"
        : "activity.task_activity_manager_planning",
    ),
    planning: state === "running",
  };
}
