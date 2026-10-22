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
  return groupIssueActivityThreads(messages).flatMap((thread) => {
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
      if (message.sender.type === "agent" && parent === discussion) {
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
        <details className="task-detail-run-events" open>
          <summary data-testid={eventTestId}>{eventLabel}</summary>
          <div>{events}</div>
        </details>
      ) : null}
    </div>
  );
}
