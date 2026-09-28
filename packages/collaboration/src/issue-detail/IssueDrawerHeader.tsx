import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";

export function IssueDrawerHeader({
  title,
  actions,
  onBack,
  onClose,
  backLabel,
  closeLabel,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onBack: () => void;
  onClose: () => void;
  backLabel: string;
  closeLabel: string;
}) {
  return (
    <header className="task-detail-workspace-header flex shrink-0 items-center">
      <button
        type="button"
        data-testid="ai-chat-modal-back"
        onClick={onBack}
        aria-label={backLabel}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
        {title}
      </span>
      {actions}
      <button
        type="button"
        data-testid="ai-chat-modal-close"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}
