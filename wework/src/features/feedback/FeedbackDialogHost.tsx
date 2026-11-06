import { TaskFeedbackDialog } from './TaskFeedbackDialog'
import { closeFeedbackDialog, useFeedbackDialogRequest } from './feedbackDialogStore'

/**
 * Renders the single application-level feedback dialog.
 *
 * Menu actions and every feedback button open this dialog through the shared
 * store, so the workbench never mounts a second copy of the form.
 */
export function FeedbackDialogHost() {
  const request = useFeedbackDialogRequest()
  if (!request) return null

  return (
    <TaskFeedbackDialog
      open
      hasActiveTask={request.hasActiveTask}
      getTaskContext={request.getTaskContext}
      feedbackApi={request.feedbackApi}
      onClose={closeFeedbackDialog}
    />
  )
}
