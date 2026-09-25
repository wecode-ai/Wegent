import type { CollaborationTranslate } from "../i18n";

export function managerAssignmentNames(
  metadata: Record<string, unknown>,
): string[] {
  if (!Array.isArray(metadata.dispatch_assignments)) return [];
  return [
    ...new Set(
      metadata.dispatch_assignments.flatMap((assignment) => {
        if (typeof assignment !== "object" || assignment === null) return [];
        const name = (assignment as Record<string, unknown>).agent_name;
        return typeof name === "string" && name.trim() ? [name.trim()] : [];
      }),
    ),
  ];
}

export function managerActivityPresentation(
  translate: CollaborationTranslate,
  metadata: Record<string, unknown>,
  state: "running" | "completed" | "failed" | "cancelled",
): { label: string; planning: boolean } {
  const assigneeNames = managerAssignmentNames(metadata);
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
  if (assigneeNames.length) {
    return {
      label: translate(
        "activity.task_activity_manager_assigned_to",
        undefined,
        { name: assigneeNames.join("、") },
      ),
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
