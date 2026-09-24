import { BrowserIssueExecution } from "./BrowserIssueExecution";
import { BrowserIssueActivityTools } from "./BrowserIssueActivityTools";
import { useIssueActivityScroll } from "./useIssueActivityScroll";
import { BrowserIssueReplies } from "./BrowserIssueReplies";
import { BrowserIssueCommentComposer } from "./BrowserIssueCommentComposer";
import { issueTaskSummaryForMessage } from "./issueTaskSummary";
import type { SharedIssueDetailTaskBinding } from "./createSharedIssueDetailPort";
import {
  executionRuntimeAddress,
  messageRuntimeExecutionTarget,
  type RuntimeExecutionTarget,
} from "./runtimeExecutionTarget";
import { isSingleActivityExecution } from "@wegent/chat-core/activity-execution-turn";
import { IssueActivityFeed } from "./IssueActivityFeed";
import { IssueMarkdownProvider } from "./IssueMarkdownProvider";
import { IssueWebCommentComposer } from "./IssueWebCommentComposer";
import { groupIssueActivityThreads } from "./IssueActivityThread";
import { IssueActivityContent } from "./IssueActivityContent";
import { compareIssueTimestamps } from "./issueTimestamp";
import { IssueActivityMarkdown } from "./IssueActivityMarkdown";
import { IssueProjectChatThread } from "./IssueProjectChatThread";
import { useIssueProjectChat } from "./useIssueProjectChat";
import { useIssueExecutionCancellation } from "./useIssueExecutionCancellation";
import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  IssueActivityCard,
  IssueActivityMessage,
} from "./IssueActivityPresentation";
import { useCallback, useMemo } from "react";

import { executionStatusLabel } from "./executionStatusLabel";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationAssignment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationProject,
  CollaborationMember,
} from "../types";

import { issueActivityEntries } from "./issueActivityEntries";
import { activityDisplayBody } from "./activityDisplayBody";
import { useIssueDispatchController } from "./IssueDispatchPanel";

export function IssueActivityPanel({
  api,
  issue,
  project,
  onTaskUpdated,
  members,
  agents,
  assignments,
  comments,
  executions,
  canComment,
  canAttach = canComment,
  translate,
  onCommentsChange,
  onError,
  onOpenExecution,
  onOpenAttachment,
  taskBindings = [],
  onOpenTaskConversation,
}: {
  api: Pick<SharedWorkspaceApi, "assignments" | "comments" | "activity"> &
    Partial<
      Pick<
        SharedWorkspaceApi,
        "attachments" | "runtime" | "taskBindings" | "issues" | "dispatches"
      >
    >;
  issue: CollaborationIssue;
  project?: CollaborationProject;
  onTaskUpdated?(issue: CollaborationIssue): void;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  assignments: CollaborationAssignment[];
  comments: CollaborationComment[];
  executions: CollaborationExecution[];
  canComment: boolean;
  canAttach?: boolean;
  translate(
    key: string,
    fallback?: string,
    options?: Record<string, string | number>,
  ): string;
  onCommentsChange(comments: CollaborationComment[]): void;
  onError(): void;
  taskBindings?: SharedIssueDetailTaskBinding[];
  onOpenTaskConversation?(binding: SharedIssueDetailTaskBinding): void;
  onOpenAttachment?(id: string, filename: string): void;
  onOpenExecution?(target: RuntimeExecutionTarget): void;
}) {
  const chat = useIssueProjectChat(
    api.activity,
    issue.cloud_project_id,
    issue.id,
  );
  const cancel = useCallback(
    (address: RuntimeTaskAddress) => {
      if (!api.runtime)
        throw new Error("Runtime execution service is unavailable");
      return api.runtime.cancel(address);
    },
    [api.runtime],
  );
  const cancellation = useIssueExecutionCancellation(
    issue.id,
    cancel,
    translate("activity.task_activity_stop_failed"),
  );
  const scroll = useIssueActivityScroll({
    messages: chat.messages,
    loading: chat.loading,
    cardTestIdPrefix: "collaboration-chat-card-",
  });
  const threads = useMemo(
    () => groupIssueActivityThreads(chat.messages),
    [chat.messages],
  );
  const addressedMessages = useMemo(
    () =>
      chat.messages.map(
        (message) =>
          messageRuntimeExecutionTarget(
            message,
            executions.find(
              (run) => run.id === Number(message.metadata.execution_id),
            ),
          )?.activityMessage ?? message,
      ),
    [chat.messages, executions],
  );
  // Project chat is the canonical PC activity stream. REST records describe
  // the same work and belong only to hosts without a project-chat transport.
  const entries = useMemo(
    () =>
      api.activity
        ? []
        : issueActivityEntries(assignments, comments, executions),
    [api.activity, assignments, comments, executions],
  );
  const dispatch = useIssueDispatchController({
    api: api.dispatches,
    issueId: issue.id,
    desktop: false,
    translate,
    onIssueChanged: api.issues && onTaskUpdated
      ? async () => onTaskUpdated(await api.issues!.get(issue.id))
      : undefined,
  });

  const content = (
    <IssueMarkdownProvider attachments={api.attachments}>
      <IssueActivityFeed
        testId="collaboration-issue-activity"
        listTestId="collaboration-comments"
        listRef={scroll.listRef}
        translate={translate}
        count={entries.length + chat.messages.length + dispatch.activityCount}
        loading={chat.loading}
        error={chat.error ?? cancellation.error}
        emptyDescription={
          issue.assignee_agent_name || issue.assignee_team_name
            ? translate("activity.task_activity_empty_with_ai", undefined, {
                name:
                  issue.assignee_agent_name || issue.assignee_team_name || "",
              })
            : translate("activity.task_activity_empty_without_ai")
        }
        tools={
          <div className="flex items-center gap-2">
            {api.issues ? (
            <BrowserIssueActivityTools
              key={issue.id}
              api={{ ...api, issues: api.issues }}
              issue={issue}
              project={project}
              agents={agents}
              currentUserId={chat.currentUserId}
              messages={chat.messages}
              onMessages={chat.merge}
              onTaskUpdated={onTaskUpdated}
              translate={translate}
            />
            ) : null}
            {dispatch.tools}
          </div>
        }
        composer={
          api.runtime &&
          api.activity &&
          api.attachments &&
          api.taskBindings &&
          api.issues &&
          project ? (
            <BrowserIssueCommentComposer
              key={issue.id}
              api={{
                attachments: api.attachments,
                taskBindings: api.taskBindings,
                issues: api.issues,
              }}
              runtime={api.runtime}
              client={api.activity}
              project={project}
              issue={issue}
              agents={agents}
              members={members}
              messages={chat.messages}
              canComment={canComment}
              canAttach={canAttach}
              loading={chat.loading}
              translate={translate}
              onMessages={chat.merge}
              onCommentPersisted={(message) => {
                scroll.followCard(message.messageId);
                scroll.scrollTaskCommentsToBottom();
              }}
              onTaskUpdated={onTaskUpdated}
            />
          ) : (
            <IssueWebCommentComposer
              key={issue.id}
              issueId={issue.id}
              attachmentApi={api.attachments}
              canComment={canComment}
              canAttach={canAttach}
              loading={chat.loading}
              members={members}
              agents={agents}
              translate={translate}
              send={async (body, mentions) => {
                if (api.activity) {
                  await chat.send(body, undefined, mentions);
                  return;
                }
                return api.comments.create(issue.id, body);
              }}
              onSent={(comment) => onCommentsChange([...comments, comment])}
              onError={onError}
            />
          )
        }
      >
        <div className="flex flex-col">
          {dispatch.activity}
          {[
            ...threads.map((thread) => ({
              kind: "thread" as const,
              at: thread.root.createdAt,
              thread,
            })),
            ...entries,
          ]
            .sort((left, right) => compareIssueTimestamps(left.at, right.at))
            .map((entry) => {
              if (entry.kind === "thread")
                return (
                  <IssueProjectChatThread
                    key={`thread:${entry.thread.root.messageId}`}
                    thread={entry.thread}
                    canComment={canComment}
                    send={chat.send}
                    members={members}
                    agents={agents}
                    upload={
                      canAttach && api.attachments
                        ? (file) => api.attachments!.upload(issue.id, file)
                        : undefined
                    }
                    remove={
                      api.attachments
                        ? (id) => api.attachments!.remove(id)
                        : undefined
                    }
                    translate={translate}
                    executions={executions}
                    singleExecutionForMessage={(message) =>
                      isSingleActivityExecution(addressedMessages, message)
                    }
                    taskSummaryForMessage={(message) =>
                      issueTaskSummaryForMessage(
                        message,
                        taskBindings,
                        issue.title,
                        onOpenTaskConversation,
                      )
                    }
                    onOpenExecution={onOpenExecution}
                    onStopExecution={
                      api.runtime ? cancellation.stop : undefined
                    }
                    stoppingMessageId={cancellation.stoppingMessageId}
                    onOpenAttachment={onOpenAttachment}
                  />
                );
              const id =
                entry.kind === "comment"
                  ? entry.comment.id
                  : entry.kind === "assignment"
                    ? entry.assignment.id
                    : String(entry.run.id);
              const author =
                entry.kind === "comment"
                  ? entry.comment.author
                  : entry.kind === "assignment"
                    ? entry.assignment.created_by_user_name ||
                      translate("todo.someone", "项目成员")
                    : translate(
                        entry.run.executor_type === "automation_manager"
                          ? "todo.execution_manager_run"
                          : "todo.execution_run",
                        entry.run.executor_type === "automation_manager"
                          ? "AI 调度"
                          : "执行任务",
                      );
              const content =
                entry.kind === "comment"
                  ? activityDisplayBody(entry.comment.body, "")
                  : entry.kind === "assignment"
                    ? activityDisplayBody(
                        entry.assignment.body,
                        `${translate("todo.assigned_to", "分配给")} @${entry.assignment.target_name}`,
                      )
                    : null;
              const boundTask =
                entry.kind === "run"
                  ? taskBindings.find(
                      (binding) =>
                        binding.device_id === entry.run.runtime_device_id &&
                        binding.task_id === entry.run.runtime_task_id,
                    )
                  : undefined;
              return (
                <IssueActivityCard key={`${entry.kind}:${id}`}>
                  <IssueActivityMessage
                    data-testid={
                      entry.kind === "assignment"
                        ? `collaboration-assignment-${id}`
                        : entry.kind === "run"
                          ? `collaboration-run-${id}`
                          : `collaboration-comment-${id}`
                    }
                    author={author}
                    createdAt={entry.at}
                    agent={entry.kind === "run"}
                  >
                    {entry.kind === "run" ? (
                      <>
                        <div className="task-detail-thread-task-link">
                          <button
                            type="button"
                            className="task-detail-ai-run-open-task"
                            data-testid={`collaboration-open-task-${entry.run.id}`}
                            onClick={() => {
                              if (boundTask)
                                onOpenTaskConversation?.(boundTask);
                            }}
                            disabled={!boundTask || !onOpenTaskConversation}
                          >
                            {entry.run.task_title}
                          </button>
                          <button
                            type="button"
                            className="task-detail-ai-run-open-task"
                            data-testid={`collaboration-open-execution-${entry.run.id}`}
                            disabled={
                              !onOpenExecution ||
                              !executionRuntimeAddress(entry.run)
                            }
                            onClick={() => {
                              const address = executionRuntimeAddress(
                                entry.run,
                              );
                              if (address)
                                onOpenExecution?.({
                                  address,
                                  taskTitle: entry.run.task_title,
                                  senderName: author,
                                  runId: String(entry.run.id),
                                  runStatus: entry.run.display_state,
                                });
                            }}
                          >
                            {executionStatusLabel(
                              entry.run.display_state,
                              translate,
                            )}
                          </button>
                        </div>
                        {entry.run.error_message ? (
                          <p
                            className="text-error"
                            data-testid={`collaboration-run-error-${entry.run.id}`}
                          >
                            {entry.run.error_message}
                          </p>
                        ) : null}
                        {entry.run.executor_type === "automation_manager" &&
                        entry.run.display_state === "succeeded" ? (
                          <p>
                            {translate(
                              "todo.execution_manager_completed",
                              "调度已完成；步骤执行与整个 Issue 的完成状态请查看上方进度。",
                            )}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <IssueActivityContent
                        messageId={id}
                        expandLabel={translate("todo.expand_content")}
                        collapseLabel={translate("todo.collapse_content")}
                      >
                        <IssueActivityMarkdown
                          translate={translate}
                          content={content ?? ""}
                          onOpenAttachment={onOpenAttachment}
                        />
                      </IssueActivityContent>
                    )}
                  </IssueActivityMessage>
                </IssueActivityCard>
              );
            })}
        </div>
      </IssueActivityFeed>
    </IssueMarkdownProvider>
  );
  return api.runtime &&
    api.activity &&
    api.attachments &&
    api.taskBindings &&
    api.issues &&
    project ? (
    <BrowserIssueExecution key={issue.id} runtime={api.runtime}>
      <BrowserIssueReplies
        key={issue.id}
        api={{
          attachments: api.attachments,
          taskBindings: api.taskBindings,
          issues: api.issues,
        }}
        runtime={api.runtime}
        client={api.activity}
        project={project}
        issue={issue}
        agents={agents}
        messages={chat.messages}
        onMessages={chat.merge}
        onTaskUpdated={onTaskUpdated}
        onReplyPersisted={(rootId) => {
          scroll.followCard(rootId);
          scroll.revealCardBottom(rootId);
        }}
        canComment={canComment}
        translate={translate}
      >
        {content}
      </BrowserIssueReplies>
    </BrowserIssueExecution>
  ) : (
    content
  );
}
