import { useEffect, useMemo, useState } from "react";
import { collectIssueSubtreeIds } from "../board";
import { collectIssueChildrenProgress } from "../project-board/IssueChildrenProgress";
import type { CollaborationIssue } from "../types";

export interface MilestoneFilterValue {
  /** 'all' includes every Issue; null includes only Issues without a milestone. */
  milestoneId: string | null;
}

interface MilestoneFilterOptions {
  filter?: MilestoneFilterValue;
  onChange?(milestoneId: string | null): void;
}

export function useMilestoneFilter(
  projectId: string | undefined,
  view: string,
  issues: CollaborationIssue[],
  { filter, onChange }: MilestoneFilterOptions = {},
) {
  const [selection, setSelection] = useState<{
    projectId: string;
    value: string | null;
  } | null>(null);
  const [drilldown, setDrilldown] = useState<{
    projectId: string;
    rootId: string;
    value: string | null;
  } | null>(null);
  const baseValue =
    filter !== undefined
      ? filter.milestoneId
      : selection?.projectId === projectId && selection
        ? selection.value
        : "all";
  const temporary =
    view === "board" &&
    drilldown?.projectId === projectId &&
    drilldown?.value === baseValue;
  const value = temporary ? "all" : baseValue;
  const filteredIssues = useMemo(
    () =>
      issues.filter(
        (issue) => value === "all" || (issue.milestone_id ?? null) === value,
      ),
    [issues, value],
  );

  useEffect(() => {
    setDrilldown(null);
  }, [projectId, view, baseValue]);

  return {
    filter: { milestoneId: baseValue } satisfies MilestoneFilterValue,
    value,
    filteredIssues,
    select(value: string | null) {
      if (filter === undefined && projectId) setSelection({ projectId, value });
      setDrilldown(null);
      onChange?.(value);
    },
    clear() {
      if (filter === undefined) setSelection(null);
      setDrilldown(null);
      onChange?.("all");
    },
    openChildren(issue: CollaborationIssue) {
      if (!projectId || value === "all") return;
      const total =
        collectIssueChildrenProgress(issues).get(issue.id)?.total ?? 0;
      const visible =
        collectIssueChildrenProgress(filteredIssues).get(issue.id)?.total ?? 0;
      if (visible < total)
        setDrilldown({ projectId, rootId: issue.id, value: baseValue });
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
