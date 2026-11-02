import { MessageSquareWarning } from 'lucide-react'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { EMPTY_FEEDBACK_DIALOG_REQUEST, openFeedbackDialog } from './feedbackDialogStore'

interface GlobalFeedbackButtonProps {
  testId?: string
}

export function GlobalFeedbackButton({
  testId = 'topnav-feedback-button',
}: GlobalFeedbackButtonProps) {
  const { t } = useTranslation('common')

  return (
    <Tooltip
      label={t('workbench.feedback_button')}
      side="bottom"
      align="end"
      testId={`${testId}-tooltip`}
    >
      <button
        type="button"
        data-testid={testId}
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.feedback_button')}
        onClick={() => openFeedbackDialog(EMPTY_FEEDBACK_DIALOG_REQUEST)}
      >
        <MessageSquareWarning className="h-4 w-4" />
      </button>
    </Tooltip>
  )
}
