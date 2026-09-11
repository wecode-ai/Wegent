// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";

import {
  collaborationMessages,
  createCollaborationTranslator,
  type CollaborationTranslate,
} from "./i18n";
import {
  SharedIssueDetailEditor,
  type SharedEditorIssue,
  type SharedEditorProject,
} from "./SharedIssueDetailEditor";
import { createSharedIssueDetailPort } from "./issue-detail";
import {
  dueDateTimeLocalFromSource,
  dueDateTimeLocalToSource,
} from "./issue-detail/dateTime";
import { canEditCollaborationIssue } from "./permissions";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import { collaborationTestIds } from "./testIds";
import type {
  CollaborationComment,
  CollaborationIssue,
  CollaborationProject,
} from "./types";

type Messages =
  | (typeof collaborationMessages)["zh-CN"]
  | (typeof collaborationMessages)["en"];

interface IssueDetailProps {
  api: Pick<
    SharedWorkspaceApi,
    | "issues"
    | "attachments"
    | "comments"
    | "members"
    | "agents"
    | "collaborators"
    | "taskBindings"
    | "workflowPlans"
    | "deliveries"
    | "automations"
  >;
  project: CollaborationProject;
  issue: CollaborationIssue;
  allIssues: CollaborationIssue[];
  comments: CollaborationComment[];
  messages: Messages;
  translate?: CollaborationTranslate;
  onClose(): void;
  onChange(issue: CollaborationIssue): void;
  onCommentsChange(comments: CollaborationComment[]): void;
  onConflict(): Promise<void>;
  onError(): void;
}

interface IssueCreateProps {
  api: IssueDetailProps["api"];
  project: CollaborationProject;
  allIssues: CollaborationIssue[];
  messages: Messages;
  translate?: CollaborationTranslate;
  onClose(): void;
  onCreated(issue: CollaborationIssue): void | Promise<void>;
  onError(): void;
}

const browserDueDateExtensions = {
  dueDateInputType: "datetime-local" as const,
  dueDateFromSource: dueDateTimeLocalFromSource,
  dueDateToSource: dueDateTimeLocalToSource,
};

function browserSave(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return Promise.resolve();
}

function useBrowserIssueDetailPort(
  api: IssueDetailProps["api"],
  onError: () => void,
  onConflict?: () => Promise<void>,
) {
  return useMemo(() => {
    const basePort = createSharedIssueDetailPort(api, browserSave);
    return {
      ...basePort,
      issues: {
        ...basePort.issues,
        create: async (...args: Parameters<typeof basePort.issues.create>) => {
          try {
            return await basePort.issues.create(...args);
          } catch (error) {
            onError();
            throw error;
          }
        },
        update: async (...args: Parameters<typeof basePort.issues.update>) => {
          try {
            return await basePort.issues.update(...args);
          } catch (error) {
            if (
              onConflict &&
              error &&
              typeof error === "object" &&
              "status" in error &&
              error.status === 409
            ) {
              await onConflict();
            } else {
              onError();
            }
            throw error;
          }
        },
        assign: async (...args: Parameters<typeof basePort.issues.assign>) => {
          try {
            return await basePort.issues.assign(...args);
          } catch (error) {
            onError();
            throw error;
          }
        },
      },
    };
  }, [api, onConflict, onError]);
}

export function IssueCreate({
  api,
  project,
  allIssues,
  messages,
  translate,
  onClose,
  onCreated,
  onError,
}: IssueCreateProps) {
  const port = useBrowserIssueDetailPort(api, onError);
  const editorTranslate =
    translate ??
    createCollaborationTranslator(
      messages === collaborationMessages.en ? "en" : "zh-CN",
    );
  return (
    <div data-testid={collaborationTestIds.createIssueDialog}>
      <SharedIssueDetailEditor
        port={port}
        mode="create"
        project={project as SharedEditorProject}
        allItems={allIssues as SharedEditorIssue[]}
        initialParent={null}
        initialStatus={project.board_config?.statuses?.[0]?.id ?? "inbox"}
        onClose={onClose}
        onCreated={onCreated}
        translate={editorTranslate}
        extensions={browserDueDateExtensions}
      />
    </div>
  );
}

export function IssueDetail({
  api,
  project,
  issue,
  allIssues,
  comments,
  messages,
  translate,
  onClose,
  onChange,
  onCommentsChange,
  onConflict,
  onError,
}: IssueDetailProps) {
  const [comment, setComment] = useState("");
  const editable = canEditCollaborationIssue(issue);
  const port = useBrowserIssueDetailPort(api, onError, onConflict);
  const editorTranslate =
    translate ??
    createCollaborationTranslator(
      messages === collaborationMessages.en ? "en" : "zh-CN",
    );

  return (
    <div
      className="collaboration-dialog-backdrop"
      data-testid={collaborationTestIds.issueDetail}
    >
      <div className="collaboration-issue-detail-shared-host">
        <SharedIssueDetailEditor
          port={port}
          mode="edit"
          item={issue as SharedEditorIssue}
          editable={editable}
          project={project as SharedEditorProject}
          allItems={allIssues as SharedEditorIssue[]}
          onClose={onClose}
          onUpdated={(updated) => onChange(updated)}
          presentation="workspace-panel"
          workspacePanelFill
          showPanelControls
          translate={editorTranslate}
          extensions={{
            ...browserDueDateExtensions,
            openAttachment: async (attachmentId) => {
              const access = await api.attachments.access(attachmentId);
              window.open(access.url, "_blank", "noopener,noreferrer");
            },
            renderActivity: () => (
              <section className="task-detail-comments collaboration-comment">
                <header className="task-detail-comments-head">
                  <span className="font-semibold text-text-primary">
                    {messages.comment}
                  </span>
                  <span>{comments.length}</span>
                </header>
                <div
                  className="task-detail-comments-list collaboration-comment-list"
                  data-testid="collaboration-comments"
                >
                  {comments.map((entry) => (
                    <article key={entry.id}>
                      <strong>{entry.author}</strong>
                      <p>{entry.body}</p>
                    </article>
                  ))}
                </div>
                <div className="collaboration-comment-composer">
                  <textarea
                    data-testid={collaborationTestIds.issueComment}
                    placeholder={messages.commentPlaceholder}
                    value={comment}
                    disabled={!editable}
                    onChange={(event) => setComment(event.target.value)}
                  />
                  <button
                    type="button"
                    data-testid={collaborationTestIds.issueCommentSubmit}
                    disabled={!editable || !comment.trim()}
                    onClick={async () => {
                      if (!editable) return;
                      try {
                        const created = await api.comments.create(
                          issue.id,
                          comment.trim(),
                        );
                        onCommentsChange([...comments, created]);
                        setComment("");
                      } catch {
                        onError();
                      }
                    }}
                  >
                    {messages.comment}
                  </button>
                </div>
              </section>
            ),
          }}
        />
      </div>
    </div>
  );
}
