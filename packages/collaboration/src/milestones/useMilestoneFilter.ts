import { useEffect, useState } from "react";
import { collectIssueSubtreeIds } from "../board";
import { collectIssueChildrenProgress } from "../project-board/IssueChildrenProgress";
import type { CollaborationIssue } from "../types";

export function useMilestoneFilter(
  projectId: string | undefined,
  view: string,
  issues: CollaborationIssue[],
) {
  const [selection, setSelection] = useState<{
    projectId: string;
    value: string | null;
  } | null>(null);
  const [drilldown, setDrilldown] = useState<{
    projectId: string;
    rootId: string;
  } | null>(null);
  const baseValue =
    selection?.projectId === projectId && selection ? selection.value : "all";
  const temporary = view === "board" && drilldown?.projectId === projectId;
  const value = temporary ? "all" : baseValue;
  const filteredIssues = issues.filter(
    (issue) => value === "all" || (issue.milestone_id ?? null) === value,
  );

  useEffect(() => {
    setDrilldown(null);
  }, [projectId, view]);

  return {
    value,
    filteredIssues,
    select(value: string | null) {
      if (projectId) setSelection({ projectId, value });
      setDrilldown(null);
    },
    clear() {
      setSelection(null);
      setDrilldown(null);
    },
    openChildren(issue: CollaborationIssue) {
      if (!projectId || value === "all") return;
      const total =
        collectIssueChildrenProgress(issues).get(issue.id)?.total ?? 0;
      const visible =
        collectIssueChildrenProgress(filteredIssues).get(issue.id)?.total ?? 0;
      if (visible < total) setDrilldown({ projectId, rootId: issue.id });
    },
    changeParent(parentId: string | null) {
      setDrilldown((current) =>
        current &&
        parentId &&
        collectIssueSubtreeIds(issues, current.rootId).has(parentId)
          ? current
          : null,
      );
    },
  };
}
