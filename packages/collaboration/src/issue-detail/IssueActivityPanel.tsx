// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";

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
  const [workflowStep, setWorkflowStep] = useState("");
  const [target, setTarget] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setBody("");
    setWorkflowStep("");
    setTarget("");
  }, [issue.id]);
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
        .filter((execution) => execution.loop_item_id === issue.id)
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
        .at(-1) ?? null,
    [executions, issue.id],
  );
  const selectedTarget = target
    ? target.startsWith("human:")
      ? members
          .map((member) => ({
            id: `human:${member.user_id}`,
            name: member.user_name,
            type: "human" as const,
            targetId: String(member.user_id),
          }))
          .find((candidate) => candidate.id === target)
      : agents
          .map((agent) => ({
            id: `agent:${agent.id}`,
            name: agent.name,
            type: "agent" as const,
            targetId: agent.id,
          }))
          .find((candidate) => candidate.id === target)
    : null;

  const submit = async () => {
    if (!body.trim() && !selectedTarget) return;
    if (selectedTarget && !canAssign) return;
    if (!selectedTarget && !canComment) return;
    setSending(true);
    try {
      if (selectedTarget) {
        if (!api.assignments) throw new Error("Assignments API is unavailable");
        const result = await api.assignments.create(issue.id, {
          targetType: selectedTarget.type,
          targetId: selectedTarget.targetId,
          workflowStep: workflowStep.trim() || null,
          commentBody: canComment ? body.trim() || undefined : undefined,
          notifyTarget: selectedTarget.type === "human",
        });
        onAssignmentsChange([...assignments, result.assignment]);
        if (result.comment) onCommentsChange([...comments, result.comment]);
        onIssueChange(result.issue);
      } else {
        const comment = await api.comments.create(issue.id, body.trim());
        onCommentsChange([...comments, comment]);
      }
      setBody("");
      setTarget("");
      setWorkflowStep("");
    } catch {
      onError();
    } finally {
      setSending(false);
    }
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
          {translate("todo.activity", "动态与分配")}
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
              <article key={`comment:${entry.comment.id}`}>
                <strong>{entry.comment.author}</strong>
                <p>{entry.comment.body}</p>
                <time>
                  {entry.comment.created_at.slice(0, 16).replace("T", " ")}
                </time>
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
                <strong>
                  {entry.assignment.created_by_user_name ||
                    translate("todo.someone", "项目成员")}
                </strong>
                <p>
                  {translate("todo.assigned_to", "分配给")}{" "}
                  <b>@{entry.assignment.target_name}</b>
                  {entry.assignment.workflow_step
                    ? ` · ${translate("todo.workflow_step", "流程步骤")}：${entry.assignment.workflow_step}`
                    : ""}
                </p>
                {entry.assignment.body ? <p>{entry.assignment.body}</p> : null}
                <time>
                  {entry.assignment.created_at.slice(0, 16).replace("T", " ")}
                </time>
              </article>
            );
          }
          return (
            <article
              className="collaboration-run-event"
              data-testid={`collaboration-run-${entry.run.id}`}
              key={`run:${entry.run.id}`}
            >
              <strong>{translate("todo.execution_run", "执行任务")}</strong>
              <p>
                {entry.run.task_title} · {entry.run.display_state}
              </p>
              <time>{entry.run.created_at.slice(0, 16).replace("T", " ")}</time>
            </article>
          );
        })}
      </div>
      <div className="collaboration-activity-composer-shell">
        <div className="collaboration-assignment-targets">
          <span>@</span>
          <select
            aria-label={translate("todo.assignment_target", "分配对象")}
            data-testid="collaboration-assignment-target"
            disabled={!canAssign || sending || !api.assignments}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">
              {translate("todo.no_assignment_target", "仅评论，不分配")}
            </option>
            <optgroup label={translate("todo.members", "成员")}>
              {members.map((member) => (
                <option key={member.user_id} value={`human:${member.user_id}`}>
                  {member.user_name}
                </option>
              ))}
            </optgroup>
            <optgroup label={translate("todo.agent_teams", "智能体")}>
              {agents.map((agent) => (
                <option key={agent.id} value={`agent:${agent.id}`}>
                  {agent.name}
                </option>
              ))}
            </optgroup>
          </select>
          <input
            aria-label={translate("todo.workflow_step", "流程步骤")}
            data-testid="collaboration-assignment-workflow-step"
            disabled={!canAssign || !selectedTarget || sending}
            placeholder={translate(
              "todo.workflow_step_optional",
              "流程步骤（可选）",
            )}
            value={workflowStep}
            onChange={(event) => setWorkflowStep(event.target.value)}
          />
        </div>
        <div className="collaboration-comment-composer">
          <textarea
            data-testid="collaboration-issue-comment"
            placeholder={translate(
              "todo.comment_or_assign",
              "写评论，或选择对象完成分配",
            )}
            value={body}
            disabled={!canComment || sending}
            onChange={(event) => setBody(event.target.value)}
          />
          <button
            type="button"
            data-testid="collaboration-issue-comment-submit"
            disabled={
              sending ||
              (!body.trim() && !selectedTarget) ||
              (selectedTarget ? !canAssign : !canComment)
            }
            onClick={() => void submit()}
          >
            {selectedTarget
              ? translate("todo.assign_and_send", "分配并发送")
              : translate("todo.send_comment", "发送")}
          </button>
        </div>
        <p className="collaboration-assignment-note">
          {translate(
            "todo.assignment_non_exclusive",
            "分配用于通知和触发执行，不限制其他成员主动参与。",
          )}
        </p>
      </div>
    </section>
  );
}
