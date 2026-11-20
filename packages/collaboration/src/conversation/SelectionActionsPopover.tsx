import { Popover, PopoverContent } from "../controls/Popover";
import { Button as ControlButton } from "../markdown/Button";
import { useCollaborationPortalTheme } from "../theme/CollaborationTheme";
import { useConversationTranslation } from "./ConversationTranslation";

export interface SelectionActionsPosition {
  left: number;
  top: number;
}

interface SelectionActionsPopoverProps {
  position: SelectionActionsPosition;
  onClose?: () => void;
  onAddToConversation?: () => void;
  onFillAnswer?: () => void;
  onAskInSidebar?: () => void;
  testId?: string;
  addButtonTestId?: string;
  askButtonTestId?: string;
}

export function SelectionActionsPopover({
  position,
  onClose,
  onAddToConversation,
  onAskInSidebar,
  onFillAnswer,
  testId = "message-selection-actions",
  addButtonTestId = "add-selection-to-conversation-button",
  askButtonTestId = "ask-selection-in-sidebar-button",
}: SelectionActionsPopoverProps) {
  const { t } = useConversationTranslation();
  const portalTheme = useCollaborationPortalTheme();

  return (
    <Popover
      open
      modal={false}
      dismissible={Boolean(onClose)}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <PopoverContent
        {...portalTheme}
        container={document.body}
        anchor={{ x: position.left, y: position.top }}
        side="top"
        sideOffset={0}
        initialFocus="none"
        finalFocus="none"
        aria-label={t("workbench.add_selection_to_conversation")}
        data-testid={testId}
        className={`flex items-center gap-1 p-1 ${portalTheme.className}`}
        onPointerDown={(event) => event.preventDefault()}
      >
        {onAddToConversation && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={addButtonTestId}
            className="h-8 rounded-md px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
            onClick={onAddToConversation}
          >
            {t("workbench.add_selection_to_conversation")}
          </ControlButton>
        )}
        {onFillAnswer && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="fill-selection-to-answer-button"
            className="min-h-11 rounded-md px-2.5 text-sm text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:min-h-8"
            onClick={onFillAnswer}
          >
            {t("workbench.fill_selection_to_answer")}
          </ControlButton>
        )}
        {onAskInSidebar ? (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={askButtonTestId}
            className="h-8 rounded-md px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
            onClick={onAskInSidebar}
          >
            {t("workbench.ask_selection_in_sidebar")}
          </ControlButton>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
