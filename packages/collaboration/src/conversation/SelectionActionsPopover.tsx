import { useCollaborationPortalTheme } from "../theme/CollaborationTheme";
import { createPortal } from "react-dom";
import { useConversationTranslation } from "./ConversationTranslation";

export interface SelectionActionsPosition {
  left: number;
  top: number;
}

interface SelectionActionsPopoverProps {
  position: SelectionActionsPosition;
  onAddToConversation?: () => void;
  onFillAnswer?: () => void;
  onAskInSidebar?: () => void;
  testId?: string;
  addButtonTestId?: string;
  askButtonTestId?: string;
}

export function SelectionActionsPopover({
  position,
  onAddToConversation,
  onAskInSidebar,
  onFillAnswer,
  testId = "message-selection-actions",
  addButtonTestId = "add-selection-to-conversation-button",
  askButtonTestId = "ask-selection-in-sidebar-button",
}: SelectionActionsPopoverProps) {
  const { t } = useConversationTranslation();
  const portalTheme = useCollaborationPortalTheme();

  return createPortal(
    <div
      {...portalTheme}
      data-testid={testId}
      className={`fixed z-critical flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-lg border border-border bg-base p-1 shadow-lg ${portalTheme.className}`}
      style={{ ...portalTheme.style, left: position.left, top: position.top }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {onAddToConversation && (
        <button
          type="button"
          data-testid={addButtonTestId}
          className="h-8 rounded-md px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
          onClick={onAddToConversation}
        >
          {t("workbench.add_selection_to_conversation")}
        </button>
      )}
      {onFillAnswer && (
        <button
          type="button"
          data-testid="fill-selection-to-answer-button"
          className="min-h-11 rounded-md px-2.5 text-sm text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:min-h-8"
          onClick={onFillAnswer}
        >
          {t("workbench.fill_selection_to_answer")}
        </button>
      )}
      {onAskInSidebar ? (
        <button
          type="button"
          data-testid={askButtonTestId}
          className="h-8 rounded-md px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
          onClick={onAskInSidebar}
        >
          {t("workbench.ask_selection_in_sidebar")}
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
