// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceAssignmentsApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationAssignment, CollaborationIssue } from "../types";
import { useIssueAssignmentsByIssueId } from "./useIssueAssignmentsByIssueId";

const issue = {
  id: "issue-1",
} as CollaborationIssue;
const issues = [issue];

const assignment = {
  id: "comment-assignment-1",
  issue_id: issue.id,
} as CollaborationAssignment;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useIssueAssignmentsByIssueId", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not let an older load overwrite a committed assignment mutation", async () => {
    const pending = deferred<CollaborationAssignment[]>();
    const assignmentsApi = {
      list: vi.fn().mockReturnValue(pending.promise),
    } as unknown as SharedWorkspaceAssignmentsApi;
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined;

    function Harness() {
      current = useIssueAssignmentsByIssueId({
        assignmentsApi,
        issues,
      });
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
    });
    expect(assignmentsApi.list).toHaveBeenCalledWith(issue.id);

    act(() => {
      current?.replaceIssueAssignments(issue.id, [assignment]);
    });
    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });

    expect(current?.assignmentsByIssueId[issue.id]).toEqual([assignment]);
  });
});
