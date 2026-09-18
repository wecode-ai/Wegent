import { ArrowUp, UserRound } from "lucide-react";
import type { ReactNode } from "react";

export function IssueInlineCommentComposer({
  children,
  canSend,
  onSend,
  sendLabel,
  testId,
  sendTestId,
}: {
  children: ReactNode;
  canSend: boolean;
  onSend(): void;
  sendLabel: string;
  testId: string;
  sendTestId: string;
}) {
  return (
    <div className="task-detail-comment-inline-composer" data-testid={testId}>
      <span className="task-detail-reply-avatar" aria-hidden="true">
        <UserRound className="h-4 w-4" />
      </span>
      {children}
      <button
        type="button"
        data-testid={sendTestId}
        disabled={!canSend}
        onClick={onSend}
        aria-label={sendLabel}
        className="task-detail-comment-send"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
