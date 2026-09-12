// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type { SharedWorkspaceAssignmentsApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationAssignment, CollaborationIssue } from "../types";
import { visibleIssueAssignments } from "./model";

export function useIssueAssignmentsByIssueId({
  assignmentsApi,
  issues,
  enabled = true,
}: {
  assignmentsApi: SharedWorkspaceAssignmentsApi | undefined;
  issues: CollaborationIssue[];
  enabled?: boolean;
}) {
  const [assignmentsByIssueId, setAssignmentsByIssueId] = useState<
    Record<string, CollaborationAssignment[]>
  >({});
  const loadRevisionRef = useRef(0);

  useEffect(() => {
    const revision = ++loadRevisionRef.current;
    if (!enabled) {
      setAssignmentsByIssueId({});
      return;
    }
    if (!assignmentsApi) {
      setAssignmentsByIssueId(
        Object.fromEntries(
          issues.map((issue) => [
            issue.id,
            visibleIssueAssignments(issue, undefined),
          ]),
        ),
      );
      return;
    }
    setAssignmentsByIssueId((current) =>
      Object.fromEntries(
        issues.map((issue) => [issue.id, current[issue.id] ?? []]),
      ),
    );
    void Promise.all(
      issues.map(async (issue) => {
        try {
          return [issue.id, await assignmentsApi.list(issue.id)] as const;
        } catch {
          return [issue.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (loadRevisionRef.current !== revision) return;
      setAssignmentsByIssueId((current) =>
        Object.fromEntries(
          entries.map(([issueId, assignments]) => [
            issueId,
            assignments ?? current[issueId] ?? [],
          ]),
        ),
      );
    });
    return () => {
      if (loadRevisionRef.current === revision) loadRevisionRef.current += 1;
    };
  }, [assignmentsApi, enabled, issues]);

  const replaceIssueAssignments = useCallback(
    (issueId: string, assignments: CollaborationAssignment[]) => {
      loadRevisionRef.current += 1;
      setAssignmentsByIssueId((current) => ({
        ...current,
        [issueId]: assignments,
      }));
    },
    [],
  );

  return { assignmentsByIssueId, replaceIssueAssignments };
}
