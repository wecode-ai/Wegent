import {
  IssueParticipantPicker as SharedIssueParticipantPicker,
  PersonalIssueTranslation,
} from '@wegent/collaboration/platform'
import type { ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function IssueParticipantPicker(props: ComponentProps<typeof SharedIssueParticipantPicker>) {
  const { t } = useTranslation('common')
  return (
    <PersonalIssueTranslation.Provider value={(key, options) => t(key, options)}>
      <SharedIssueParticipantPicker {...props} />
    </PersonalIssueTranslation.Provider>
  )
}
