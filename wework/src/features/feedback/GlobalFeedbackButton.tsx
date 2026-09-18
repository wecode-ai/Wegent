import { useState } from 'react'
import { MessageSquareWarning } from 'lucide-react'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskFeedbackDialog } from './TaskFeedbackDialog'

interface GlobalFeedbackButtonProps {
  testId?: string
}

export function GlobalFeedbackButton({
  testId = 'topnav-feedback-button',
}: GlobalFeedbackButtonProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.feedback_button')}
        title={t('workbench.feedback_button')}
        onClick={() => setOpen(true)}
      >
        <MessageSquareWarning className="h-4 w-4" />
      </button>
      <TaskFeedbackDialog
        open={open}
        hasActiveTask={false}
        onClose={() => setOpen(false)}
        getTaskContext={() => Promise.resolve({})}
      />
    </>
  )
}
