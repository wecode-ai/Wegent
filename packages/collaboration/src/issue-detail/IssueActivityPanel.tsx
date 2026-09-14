// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { executionStatusLabel } from "./executionStatusLabel";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationAssignment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationMember,
} from "../types";

type ActivityEntry =
  | { kind: "assignment"; at: string; assignment: CollaborationAssignment }
  | { kind: "comment"; at: string; comment: CollaborationComment }
  | { kind: "run"; at: string; run: CollaborationExecution };

type CommentAssignmentTarget = {
  type: "human" | "agent";
  targetId: string;
};

type SelectedAssignmentTarget = CommentAssignmentTarget & {
  name: string;
  start: number;
  end: number;
};

export function reconcileSelectedAssignmentTarget(
  previousBody: string,
  nextBody: string,
  target: SelectedAssignmentTarget | null,
): SelectedAssignmentTarget | null {
  if (!target) return null;

  let prefixLength = 0;
  while (
    prefixLength < previousBody.length &&
    prefixLength < nextBody.length &&
    previousBody[prefixLength] === nextBody[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousBody.length - prefixLength &&
    suffixLength < nextBody.length - prefixLength &&
    previousBody[previousBody.length - 1 - suffixLength] ===
      nextBody[nextBody.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const previousEditEnd = previousBody.length - suffixLength;
  let nextStart = target.start;
  let nextEnd = target.end;
  if (previousEditEnd <= target.start) {
    const delta = nextBody.length - previousBody.length;
    nextStart += delta;
    nextEnd += delta;
  } else if (prefixLength < target.end) {
    return null;
  }

  return nextBody.slice(nextStart, nextEnd) === `@${target.name}`
    ? { ...target, start: nextStart, end: nextEnd }
    : null;
}

export function issueActivityEntries(
  assignments: CollaborationAssignment[],
  comments: CollaborationComment[],
  executions: CollaborationExecution[],
): ActivityEntry[] {
  const assignmentEventIds = new Set(
    assignments.flatMap((assignment) => [
      assignment.id,
      ...(assignment.comment_id ? [assignment.comment_id] : []),
    ]),
  );
  return [
    ...assignments.map(
      (assignment): ActivityEntry => ({
        kind: "assignment",
        at: assignment.created_at,
        assignment,
      }),
    ),
    ...comments
      .filter((comment) => !assignmentEventIds.has(comment.id))
      .map(
        (comment): ActivityEntry => ({
          kind: "comment",
          at: comment.created_at,
          comment,
        }),
      ),
    ...executions.map(
      (run): ActivityEntry => ({
        kind: "run",
        at: run.created_at,
        run,
      }),
    ),
  ].sort((left, right) => left.at.localeCompare(right.at));
}

export function activityDisplayBody(body: string, fallback: string): string {
  const marker = body.trim();
  if (!marker || !/^[A-Z0-9_]+$/.test(marker)) return body || fallback;
  const actor = marker.includes("CLAUDE")
    ? "Claude"
    : marker.includes("CODEX")
      ? "Codex"
      : null;
  if (actor === "Claude" && /(COMPLETED|PASSED)/.test(marker))
    return "Claude 已完成，Codex 阶段已自动解锁";
  if (actor === "Codex" && /(COMPLETED|PASSED)/.test(marker))
    return "Codex 已完成，所有自动化阶段已完成";
  if (actor && /(PLAN_SUBMITTED|ASSIGNED|STARTED)/.test(marker))
    return `自动化规则已将当前阶段分配给 ${actor}`;
  return "自动化流程已更新";
}

export function IssueActivityPanel({
  api,
  issue,
  members,
  agents,
  assignments,
  comments,
  executions,
  canComment,
  canAssign,
  showCurrentAssignment = true,
  translate,
  onIssueChange,
  onAssignmentsChange,
  onCommentsChange,
  onError,
}: {
  api: Pick<SharedWorkspaceApi, "assignments" | "comments">;
  issue: CollaborationIssue;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  assignments: CollaborationAssignment[];
  comments: CollaborationComment[];
  executions: CollaborationExecution[];
  canComment: boolean;
  canAssign: boolean;
  showCurrentAssignment?: boolean;
  translate(
    key: string,
    fallback?: string,
    options?: Record<string, string | number>,
  ): string;
  onIssueChange(issue: CollaborationIssue): void;
  onAssignmentsChange(assignments: CollaborationAssignment[]): void;
  onCommentsChange(comments: CollaborationComment[]): void;
  onError(): void;
}) {
  const [body, setBody] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [selectedAssignment, setSelectedAssignment] =
    useState<SelectedAssignmentTarget | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const mentionCaretRef = useRef<number | null>(null);
  const submissionIdRef = useRef(0);
  useEffect(() => {
    submissionIdRef.current += 1;
    mentionCaretRef.current = null;
    setBody("");
    setMentionOpen(false);
    setComposerExpanded(false);
    setSelectedAssignment(null);
    setSending(false);
    return () => {
      submissionIdRef.current += 1;
      mentionCaretRef.current = null;
    };
  }, [issue.id]);
  useLayoutEffect(() => {
    const caret = mentionCaretRef.current;
    if (caret === null) return;
    mentionCaretRef.current = null;
    commentRef.current?.focus();
    commentRef.current?.setSelectionRange(caret, caret);
  }, [body]);
  const entries = useMemo(
    () => issueActivityEntries(assignments, comments, executions),
    [assignments, comments, executions],
  );
  const currentAssignment = useMemo(
    () =>
      assignments
        .filter((assignment) => assignment.status === "active")
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .at(-1) ?? null,
    [assignments],
  );
  const currentExecution = useMemo(
    () =>
      executions
        .filter(
          (execution) =>
            execution.loop_item_id === issue.id &&
            (!currentAssignment ||
              execution.created_at >= currentAssignment.updated_at),
        )
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .at(-1) ?? null,
    [currentAssignment, executions, issue.id],
  );
  const pendingAssignment = useMemo(() => {
    if (!canAssign || !selectedAssignment) return null;
    if (
      assignments.some(
        (assignment) =>
          assignment.status === "active" &&
          assignment.target_type === selectedAssignment.type &&
          assignment.target_id === selectedAssignment.targetId &&
          !assignment.workflow_step,
      )
    ) {
      return null;
    }
    return body.slice(selectedAssignment.start, selectedAssignment.end) ===
      `@${selectedAssignment.name}`
      ? selectedAssignment
      : null;
  }, [assignments, body, canAssign, selectedAssignment]);
  const submit = async () => {
    const submissionId = ++submissionIdRef.current;
    const submittedIssueId = issue.id;
    const submittedBody = body;
    const commentBody = submittedBody.trim();
    if (!commentBody) return;
    const assignmentTarget = pendingAssignment;
    if (!assignmentTarget && !canComment) return;
    mentionCaretRef.current = null;
    setBody("");
    setMentionOpen(false);
    setComposerExpanded(false);
    setSelectedAssignment(null);
    setSending(true);
    try {
      if (assignmentTarget) {
        if (!api.assignments) throw new Error("Assignments API is unavailable");
        const result = await api.assignments.create(submittedIssueId, {
          targetType: assignmentTarget.type,
          targetId: assignmentTarget.targetId,
          workflowStep: null,
          commentBody,
          notifyTarget: assignmentTarget.type === "human",
        });
        if (submissionId !== submissionIdRef.current) return;
        onAssignmentsChange([...assignments, result.assignment]);
        if (result.comment) onCommentsChange([...comments, result.comment]);
        onIssueChange(result.issue);
      } else {
        const comment = await api.comments.create(
          submittedIssueId,
          commentBody,
        );
        if (submissionId !== submissionIdRef.current) return;
        onCommentsChange([...comments, comment]);
      }
    } catch {
      if (submissionId !== submissionIdRef.current) return;
      setBody(submittedBody);
      setComposerExpanded(true);
      setSelectedAssignment(assignmentTarget);
      onError();
    } finally {
      if (submissionId === submissionIdRef.current) setSending(false);
    }
  };
  const insertMention = (
    target: CommentAssignmentTarget & { name: string },
  ) => {
    const textarea = commentRef.current;
    const start = textarea?.selectionStart ?? body.length;
    const end = textarea?.selectionEnd ?? start;
    const rawPrefix = body.slice(0, start);
    const prefix = rawPrefix.endsWith("@") ? rawPrefix.slice(0, -1) : rawPrefix;
    const suffix = body.slice(end);
    const leadingSpace = prefix && !/\s$/.test(prefix) ? " " : "";
    const trailingSpace = suffix && /^\s/.test(suffix) ? "" : " ";
    const mentionStart = prefix.length + leadingSpace.length;
    const mentionEnd = mentionStart + target.name.length + 1;
    const nextBody = `${prefix}${leadingSpace}@${target.name}${trailingSpace}${suffix}`;
    const nextCaret = mentionEnd + trailingSpace.length;
    mentionCaretRef.current = nextCaret;
    setBody(nextBody);
    setSelectedAssignment({
      ...target,
      start: mentionStart,
      end: mentionEnd,
    });
    setMentionOpen(false);
    setComposerExpanded(true);
  };

  return (
    <section
      className="task-detail-comments collaboration-comment collaboration-activity-panel"
      data-testid="collaboration-issue-activity"
    >
      {showCurrentAssignment ? (
        <section
          className="collaboration-current-assignment"
          data-testid="collaboration-current-assignment"
        >
          <header>
            <strong>{translate("todo.current_assignment", "当前分配")}</strong>
            <span>
              {currentAssignment
                ? currentExecution?.display_state ||
                  (currentAssignment.target_type === "human"
                    ? translate("todo.waiting_to_start", "等待开始")
                    : translate("todo.assigned", "已分配"))
                : translate("todo.unassigned", "尚未分配")}
            </span>
          </header>
          {currentAssignment ? (
            <div>
              <span
                className={
                  currentAssignment.target_type === "agent"
                    ? "collaboration-current-assignment-avatar is-agent"
                    : "collaboration-current-assignment-avatar"
                }
              >
                {currentAssignment.target_type === "agent"
                  ? "AI"
                  : currentAssignment.target_name.slice(0, 1)}
              </span>
              <span className="collaboration-current-assignment-main">
                <b>{currentAssignment.target_name}</b>
                <small>
                  {currentAssignment.target_type === "agent"
                    ? translate("todo.agent", "智能体")
                    : translate("todo.member", "成员")}
                  {currentExecution?.runtime_source
                    ? ` · ${currentExecution.runtime_source}`
                    : ""}
                </small>
              </span>
              <span className="collaboration-current-assignment-source">
                {translate("todo.assignment_source", "分配来源")}：
                {currentAssignment.workflow_step ||
                  translate("todo.manual_assignment", "Issue 内手动分配")}
              </span>
            </div>
          ) : (
            <p>
              {translate(
                "todo.assignment_empty_hint",
                "选择成员或智能体完成分配；其他项目成员仍可主动参与。",
              )}
            </p>
          )}
        </section>
      ) : null}
      <header className="task-detail-comments-head">
        <span className="font-semibold text-text-primary">
          {translate("todo.activity", "动态")}
        </span>
        <span>{entries.length}</span>
      </header>
      <div
        className="task-detail-comments-list collaboration-activity-list"
        data-testid="collaboration-comments"
      >
        {entries.length === 0 ? (
          <p>{translate("todo.activity_empty", "还没有动态")}</p>
        ) : null}
        {entries.map((entry) => {
          if (entry.kind === "comment") {
            return (
              <article
                className="issue-comment-event"
                key={`comment:${entry.comment.id}`}
              >
                <header>
                  <strong>{entry.comment.author}</strong>
                  <time>
                    {entry.comment.created_at.slice(0, 16).replace("T", " ")}
                  </time>
                </header>
                <p>{activityDisplayBody(entry.comment.body, "")}</p>
              </article>
            );
          }
          if (entry.kind === "assignment") {
            return (
              <article
                className="collaboration-assignment-event"
                data-testid={`collaboration-assignment-${entry.assignment.id}`}
                key={`assignment:${entry.assignment.id}`}
              >
                <header>
                  <strong>
                    {entry.assignment.created_by_user_name ||
                      translate("todo.someone", "项目成员")}
                  </strong>
                  <time>
                    {entry.assignment.created_at.slice(0, 16).replace("T", " ")}
                  </time>
                </header>
                <p>
                  {activityDisplayBody(
                    entry.assignment.body,
                    `${translate("todo.assigned_to", "分配给")} @${entry.assignment.target_name}`,
                  )}
                </p>
              </article>
            );
          }
          return (
            <article
              className="collaboration-run-event"
              data-testid={`collaboration-run-${entry.run.id}`}
              key={`run:${entry.run.id}`}
            >
              <strong>
                {entry.run.executor_type === "automation_manager"
                  ? translate("todo.execution_manager_run", "AI 调度")
                  : translate("todo.execution_run", "执行任务")}
              </strong>
              <p>
                {entry.run.task_title} ·{" "}
                {executionStatusLabel(entry.run.display_state, translate)}
              </p>
              {entry.run.executor_type === "automation_manager" &&
              entry.run.display_state === "succeeded" ? (
                <p>
                  {translate(
                    "todo.execution_manager_completed",
                    "调度已完成；步骤执行与整个 Issue 的完成状态请查看上方进度。",
                  )}
                </p>
              ) : null}
              <time>{entry.run.created_at.slice(0, 16).replace("T", " ")}</time>
            </article>
          );
        })}
      </div>
      <div
        className="issue-comment-composer-shell"
        data-expanded={
          composerExpanded || Boolean(body.trim()) ? "true" : "false"
        }
        onFocusCapture={() => setComposerExpanded(true)}
        onBlurCapture={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null) &&
            !body.trim()
          ) {
            setComposerExpanded(false);
            setMentionOpen(false);
          }
        }}
      >
        <textarea
          ref={commentRef}
          rows={1}
          data-testid="collaboration-issue-comment"
          aria-label={translate("todo.comment", "评论")}
          placeholder={translate(
            "todo.comment_or_assign",
            "评论，输入 @成员或 @智能体 分配任务",
          )}
          value={body}
          disabled={(!canComment && !canAssign) || sending}
          aria-describedby={
            pendingAssignment
              ? "collaboration-issue-assignment-preview"
              : undefined
          }
          onChange={(event) => {
            const nextBody = event.target.value;
            setSelectedAssignment((current) =>
              reconcileSelectedAssignmentTarget(body, nextBody, current),
            );
            setBody(nextBody);
            if (nextBody) setComposerExpanded(true);
            if (nextBody.endsWith("@")) setMentionOpen(true);
          }}
        />
        {pendingAssignment ? (
          <div
            id="collaboration-issue-assignment-preview"
            className="issue-comment-assignment-preview"
            data-testid="collaboration-issue-assignment-preview"
            role="status"
            aria-live="polite"
          >
            <span
              className={
                pendingAssignment.type === "agent" ? "is-agent" : undefined
              }
            >
              {pendingAssignment.type === "agent"
                ? "AI"
                : pendingAssignment.name.slice(0, 1)}
            </span>
            <p>
              {translate("todo.will_assign_to", "将分配给")}{" "}
              <strong>@{pendingAssignment.name}</strong>
              {pendingAssignment.type === "agent"
                ? ` · ${translate("todo.will_start_execution", "发送后开始执行")}`
                : ""}
            </p>
            <button
              type="button"
              data-testid="collaboration-issue-assignment-cancel"
              aria-label={`${translate("todo.cancel_assignment", "取消分配给")} ${pendingAssignment.name}`}
              onClick={() => {
                setSelectedAssignment(null);
                commentRef.current?.focus();
              }}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="issue-comment-composer-actions">
          <div className="issue-comment-mention">
            <button
              type="button"
              aria-label={translate("todo.mention_collaborator", "提及协作者")}
              aria-expanded={mentionOpen}
              data-testid="collaboration-issue-mention-trigger"
              disabled={(!canComment && !canAssign) || sending}
              onClick={() => {
                setComposerExpanded(true);
                setMentionOpen((current) => !current);
              }}
            >
              @
            </button>
            {mentionOpen ? (
              <div
                className="issue-comment-mention-popup"
                data-testid="collaboration-issue-mention-popup"
              >
                {members.length > 0 ? (
                  <section>
                    <h4>{translate("todo.members", "成员")}</h4>
                    {members.map((member) => (
                      <button
                        type="button"
                        key={`member:${member.user_id}`}
                        data-testid={`collaboration-issue-mention-member-${member.user_id}`}
                        onClick={() =>
                          insertMention({
                            type: "human",
                            targetId: String(member.user_id),
                            name: member.user_name,
                          })
                        }
                      >
                        <span>{member.user_name.slice(0, 1)}</span>
                        {member.user_name}
                      </button>
                    ))}
                  </section>
                ) : null}
                {agents.length > 0 ? (
                  <section>
                    <h4>{translate("todo.agent_teams", "智能体")}</h4>
                    {agents.map((agent) => (
                      <button
                        type="button"
                        key={`agent:${agent.id}`}
                        data-testid={`collaboration-issue-mention-agent-${agent.id}`}
                        onClick={() =>
                          insertMention({
                            type: "agent",
                            targetId: agent.id,
                            name: agent.name,
                          })
                        }
                      >
                        <span>AI</span>
                        {agent.name}
                      </button>
                    ))}
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="collaboration-issue-comment-submit"
            aria-label={
              pendingAssignment
                ? translate("todo.assign_and_comment", "分配并评论")
                : translate("todo.send_comment", "发送")
            }
            title={
              pendingAssignment
                ? translate("todo.assign_and_comment", "分配并评论")
                : translate("todo.send_comment", "发送")
            }
            disabled={
              sending || !body.trim() || (!pendingAssignment && !canComment)
            }
            onClick={() => void submit()}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
