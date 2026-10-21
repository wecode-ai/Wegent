// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";

import type {
  SharedIssueDetailCreateInput,
  SharedIssueDetailPort,
  SharedIssueDetailUpdateInput,
} from "./createSharedIssueDetailPort";
import { persistIssueDetailFields } from "./persistIssueDetailFields";

const editableFields = [
  "title",
  "description",
  "status",
  "priority",
  "parent_id",
  "start_at",
  "due_at",
  "tags",
] as const;

interface CreationProgress {
  projectId: string;
  issueId: string;
  input: SharedIssueDetailCreateInput;
}

/** Resume the same persisted Issue when a later creation step fails. */
export function useIssueCreation(port: SharedIssueDetailPort["issues"]) {
  const progressRef = useRef<CreationProgress | null>(null);

  return async (projectId: string, input: SharedIssueDetailCreateInput) => {
    const progress = progressRef.current;
    if (!progress || progress.projectId !== projectId) {
      const created = await port.create(projectId, input);
      progressRef.current = { projectId, issueId: created.id, input };
      return created;
    }

    // Read back a potentially committed assignment before retrying it. Only
    // apply user edits made since the last submission, preserving automation.
    const current = await port.get(progress.issueId);
    const changes = Object.fromEntries(
      editableFields
        .filter(
          (key) =>
            JSON.stringify(input[key] ?? null) !==
            JSON.stringify(progress.input[key] ?? null),
        )
        .map((key) => [key, input[key] ?? null]),
    ) as Omit<SharedIssueDetailUpdateInput, "version">;
    const updated = await persistIssueDetailFields(current, changes, port);
    progressRef.current = { projectId, issueId: updated.id, input };
    return updated;
  };
}
