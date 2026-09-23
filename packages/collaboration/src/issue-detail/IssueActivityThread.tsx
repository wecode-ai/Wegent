import type { HTMLAttributes, ReactNode } from "react";
import { IssueActivityCard } from "./IssueActivityPresentation";

export interface IssueActivityThreadModel<T> {
  root: T;
  replies: T[];
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
  events,
  eventLabel,
  eventTestId,
  repliesTestId,
  cardAttributes,
}: {
  message: ReactNode;
  replies?: ReactNode;
  composer?: ReactNode;
  events?: ReactNode;
  eventLabel?: string;
  eventTestId?: string;
  repliesTestId?: string;
  cardAttributes?: HTMLAttributes<HTMLElement> & { "data-testid"?: string };
}) {
  return (
    <div className="task-detail-thread">
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
