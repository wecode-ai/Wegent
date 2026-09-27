import { ArrowUp, Bot } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { activityClassNames as cn } from "./activityClassNames";
import { formatIssueTimestamp } from "./issueTimestamp";

export function IssueActivityAvatar({
  author,
  agent = false,
  compact = true,
}: {
  author: string;
  agent?: boolean;
  compact?: boolean;
}) {
  return (
    <span
      title={author}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        agent
          ? compact
            ? "bg-text-primary text-background"
            : "bg-violet-500/10 text-violet-600"
          : "bg-muted text-text-secondary",
      )}
    >
      {agent ? <Bot className="h-4 w-4" /> : author.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Data and execution actions belong to hosts; activity chrome is shared. */
export function IssueActivityCard(props: HTMLAttributes<HTMLElement>) {
  return <article {...props} className="task-detail-comment-card" />;
}

export function IssueActivityMessage({
  author,
  createdAt,
  agent = false,
  avatar,
  metadata,
  hideTime = false,
  children,
  ...attributes
}: HTMLAttributes<HTMLElement> & {
  author: string;
  createdAt: string;
  agent?: boolean;
  avatar?: ReactNode;
  metadata?: ReactNode;
  hideTime?: boolean;
}) {
  return (
    <article {...attributes} className="task-detail-thread-message">
      <header className="task-detail-thread-message-header">
        {avatar ?? <IssueActivityAvatar author={author} agent={agent} />}
        <span className="min-w-0 truncate font-medium text-text-primary">
          {author}
        </span>
        {metadata}
        {hideTime ? null : (
          <time className="text-sm text-text-muted" dateTime={createdAt}>
            {formatIssueTimestamp(createdAt)}
          </time>
        )}
      </header>
      <div className="task-detail-thread-message-body">{children}</div>
    </article>
  );
}

export function IssueCommentComposer({
  input,
  before,
  after,
  actions,
  canSend,
  onSubmit,
  sendLabel,
  sendTestId,
  ...attributes
}: Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  input: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
  actions?: ReactNode;
  canSend: boolean;
  onSubmit: () => void;
  sendLabel: string;
  sendTestId: string;
}) {
  return (
    <form
      {...attributes}
      className="task-detail-new-comment"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      {before}
      {input}
      <div className="task-detail-new-comment-actions">
        {actions}
        <button
          type="submit"
          data-testid={sendTestId}
          aria-label={sendLabel}
          title={sendLabel}
          className="task-detail-comment-send"
          disabled={!canSend}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
      {after}
    </form>
  );
}
