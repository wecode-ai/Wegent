// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";

import type { CollaborationAttachment } from "../types";
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
  syncAssignee: boolean;
  uploads: Map<File, Promise<CollaborationAttachment>>;
}

/** Resume the same persisted Issue when a later creation step fails. */
export function useIssueCreation(
  port: Pick<SharedIssueDetailPort, "issues" | "attachments">,
) {
  const progressRef = useRef<CreationProgress | null>(null);

  async function create(
    projectId: string,
    input: SharedIssueDetailCreateInput,
    hasAssignee: boolean,
  ) {
    const progress = progressRef.current;
    if (!progress || progress.projectId !== projectId) {
      const issue = await port.issues.create(projectId, input);
      progressRef.current = {
        projectId,
        issueId: issue.id,
        input,
        syncAssignee: hasAssignee,
        uploads: new Map(),
      };
      return { issue, syncAssignee: hasAssignee };
    }

    // Read back a potentially committed assignment before retrying it. Only
    // apply user edits made since the last submission, preserving automation.
    const current = await port.issues.get(progress.issueId);
    const changes = Object.fromEntries(
      editableFields
        .filter(
          (key) =>
            JSON.stringify(input[key] ?? null) !==
            JSON.stringify(progress.input[key] ?? null),
        )
        .map((key) => [key, input[key] ?? null]),
    ) as Omit<SharedIssueDetailUpdateInput, "version">;
    const issue = await persistIssueDetailFields(current, changes, port.issues);
    // A previously selected owner can be explicitly removed on any retry.
    // A form that never selected one still preserves task.created automation.
    progress.syncAssignee ||= hasAssignee;
    progress.input = input;
    return { issue, syncAssignee: progress.syncAssignee };
  }

  async function upload(issueId: string, files: File[]) {
    const progress = progressRef.current;
    if (!progress || progress.issueId !== issueId)
      throw new Error("Issue creation progress is unavailable");
    return Promise.all(
      files.map((file) => {
        const existing = progress.uploads.get(file);
        if (existing) return existing;
        const request = Promise.resolve()
          .then(() => port.attachments.upload(issueId, file))
          .catch((error: unknown) => {
            progress.uploads.delete(file);
            throw error;
          });
        // Retain successful and in-flight uploads until the form completes or
        // changes project, even if a different upload rejects first.
        progress.uploads.set(file, request);
        return request;
      }),
    );
  }

  return { create, upload };
}
