import { useRef } from 'react'
import {
  AutomationsPage,
  type AutomationNavigationHandle,
} from '@/features/automations/AutomationsPage'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInReviewDialog } from './StandInReviewDialog'

export function StandInScheduleDialog({
  id,
  userId,
  roleId,
  deviceId,
  onClose,
}: {
  id: string
  userId: number
  roleId: string
  deviceId: string
  onClose(): void
}) {
  const { t } = useTranslation('common')
  const editor = useRef<AutomationNavigationHandle>(null)
  return (
    <StandInReviewDialog
      open
      title={t('todo.automation_edit_title')}
      testId="stand-in-schedule-dialog"
      onClose={() => {
        if (editor.current) editor.current.requestLeave(onClose)
        else onClose()
      }}
    >
      <div className="flex h-[min(640px,70vh)] min-h-0 flex-col">
        <AutomationsPage
          ref={editor}
          embedded
          detailOnly
          initialAutomationId={id}
          standInOwner={{ userId, roleId }}
          standInDeviceId={deviceId}
          onClose={onClose}
        />
      </div>
    </StandInReviewDialog>
  )
}
