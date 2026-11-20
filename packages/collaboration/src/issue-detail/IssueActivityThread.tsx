import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsiblePanel,
} from "../controls/Collapsible";
import type { HTMLAttributes, ReactNode } from "react";
import type { ProjectChatMessage } from "@wegent/chat-core";
import { IssueActivityCard } from "./IssueActivityPresentation";

export interface IssueActivityThreadModel<T> {
  root: T;
  replies: T[];
  displayReplies?: T[];
}

/** Keep discussions in place while execution cards follow their own lifecycle. */
export function groupIssueTimelineThreads(
  messages: ProjectChatMessage[],
): IssueActivityThreadModel<ProjectChatMessage>[] {
  const publishedResults = new Map<string, Set<string>>();
  const startsByActivity = new Map<string, ProjectChatMessage>();
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  for (const message of messages) {
    const activity = message.metadata.collaboration_execution_activity_id;
    if (typeof activity !== "string") continue;
    if (message.metadata.collaboration_turn_start === true)
      startsByActivity.set(activity, message);
    const results = publishedResults.get(activity) ?? new Set<string>();
    results.add(message.content);
    publishedResults.set(activity, results);
  }
  const movedActivities = new Map<string, string>();
  const startExecutions = new Map<string, ProjectChatMessage>();
  for (const [activityId, start] of startsByActivity) {
    const activity = byId.get(activityId);
    const kind = activity?.metadata.activity_type;
    if (
      activity &&
      (kind === "member_execution" || kind === "manager_execution")
    ) {
      movedActivities.set(activityId, start.messageId);
      startExecutions.set(start.messageId, activity);
    }
  }
  const timeline = messages
    .filter(
      (message) =>
        !movedActivities.has(message.messageId) &&
        (message.type !== "agent_status" ||
          message.metadata.collaboration_guidance !== true),
    )
    .map((message) => {
      const execution = startExecutions.get(message.messageId);
      if (execution) {
        return {
          ...message,
          runtimeAddress: execution.runtimeAddress,
          status: execution.status,
          metadata: {
            ...message.metadata,
            activity_type: execution.metadata.activity_type,
            run_status: execution.metadata.run_status,
            workflow_task_title: execution.metadata.workflow_task_title,
          },
        };
      }
      const root = movedActivities.get(message.rootMessageId ?? "");
      const parent = movedActivities.get(message.replyToMessageId ?? "");
      const mirrored =
        startsByActivity.has(message.messageId) ||
        publishedResults.get(message.messageId)?.has(message.content);
      if (!root && !parent && !mirrored) return message;
      return {
        ...message,
        content: mirrored ? "" : message.content,
        rootMessageId: root ?? message.rootMessageId,
        replyToMessageId: parent ?? message.replyToMessageId,
      };
    });
  return groupIssueActivityThreads(timeline).flatMap((thread) => {
    if (thread.root.sender.type !== "user") return [thread];
    const discussion = {
      root: thread.root,
      replies: thread.replies,
      displayReplies: [] as ProjectChatMessage[],
    };
    const cards: IssueActivityThreadModel<ProjectChatMessage>[] = [discussion];
    const parents = new Map<
      string,
      IssueActivityThreadModel<ProjectChatMessage>
    >([[thread.root.messageId, discussion]]);
    for (const message of thread.replies) {
      const parent = parents.get(message.replyToMessageId ?? "") ?? discussion;
      if (
        message.sender.type === "agent" &&
        message.metadata.execution_dispatch !== "comment_only" &&
        parent === discussion
      ) {
        const execution = {
          root: message,
          replies: [] as ProjectChatMessage[],
        };
        cards.push(execution);
        parents.set(message.messageId, execution);
      } else {
        if (parent === discussion) discussion.displayReplies.push(message);
        else parent.replies.push(message);
        parents.set(message.messageId, parent);
      }
    }
    return cards;
  });
}

/** Resolve roots before replies so snapshot/event arrival order cannot split a thread. */
export function groupIssueActivityThreads<
  T extends {
    messageId: string;
    rootMessageId?: string | null;
    sequenceNumber: number;
  },
>(messages: T[]): IssueActivityThreadModel<T>[] {
  const ordered = [...messages].sort(
    (a, b) => a.sequenceNumber - b.sequenceNumber,
  );
  const roots = new Map<string, IssueActivityThreadModel<T>>();
  for (const message of ordered) {
    if (!message.rootMessageId || message.rootMessageId === message.messageId) {
      roots.set(message.messageId, { root: message, replies: [] });
    }
  }
  for (const message of ordered) {
    if (!message.rootMessageId || message.rootMessageId === message.messageId)
      continue;
    const thread = roots.get(message.rootMessageId);
    if (thread) thread.replies.push(message);
    else roots.set(message.rootMessageId, { root: message, replies: [] });
  }
  return [...roots.values()].sort(
    (a, b) => a.root.sequenceNumber - b.root.sequenceNumber,
  );
}

export function IssueActivityThread({
  message,
  replies,
  composer,
  variant = "card",
  events,
  eventLabel,
  eventTestId,
  repliesTestId,
  cardAttributes,
}: {
  message: ReactNode;
  replies?: ReactNode;
  composer?: ReactNode;
  variant?: "card" | "timeline";
  events?: ReactNode;
  eventLabel?: string;
  eventTestId?: string;
  repliesTestId?: string;
  cardAttributes?: HTMLAttributes<HTMLElement> & { "data-testid"?: string };
}) {
  return (
    <div
      className={
        variant === "timeline"
          ? "task-detail-thread is-timeline"
          : "task-detail-thread"
      }
    >
      <IssueActivityCard {...cardAttributes}>
        {message}
        {replies ? (
          <div
            className="task-detail-comment-replies"
            data-testid={repliesTestId}
          >
            {replies}
          </div>
        ) : null}
        {composer}
      </IssueActivityCard>
      {events ? (
        <CollapsibleRoot className="task-detail-run-events" defaultOpen>
          <CollapsibleTrigger data-testid={eventTestId}>
            {eventLabel}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div>{events}</div>
          </CollapsiblePanel>
        </CollapsibleRoot>
      ) : null}
    </div>
  );
}
