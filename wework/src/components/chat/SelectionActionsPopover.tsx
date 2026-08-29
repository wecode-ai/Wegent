import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'

export interface SelectionActionsPosition {
  left: number
  top: number
}

interface SelectionActionsPopoverProps {
  position: SelectionActionsPosition
  onAddToConversation: () => void
  onAskInSidebar?: () => void
  testId?: string
  addButtonTestId?: string
  askButtonTestId?: string
}

export function SelectionActionsPopover({
  position,
  onAddToConversation,
  onAskInSidebar,
  testId = 'message-selection-actions',
  addButtonTestId = 'add-selection-to-conversation-button',
  askButtonTestId = 'ask-selection-in-sidebar-button',
}: SelectionActionsPopoverProps) {
  const { t } = useTranslation('common')

  return createPortal(
    <div
      data-testid={testId}
      className="fixed z-critical flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-lg border border-border bg-base p-1 shadow-lg"
      style={{ left: position.left, top: position.top }}
      onPointerDown={event => event.preventDefault()}
    >
      <button
        type="button"
        data-testid={addButtonTestId}
        className="h-8 rounded-md px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
        onClick={onAddToConversation}
      >
        {t('workbench.add_selection_to_conversation')}
      </button>
      {onAskInSidebar ? (
        <button
          type="button"
          data-testid={askButtonTestId}
          className="h-8 rounded-md px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
          onClick={onAskInSidebar}
        >
          {t('workbench.ask_selection_in_sidebar')}
        </button>
      ) : null}
    </div>,
    document.body
  )
}
