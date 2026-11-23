import { PersonalIssueErrors as SharedPersonalIssueErrors } from '@wegent/collaboration/platform'
import { useTranslation } from '@/hooks/useTranslation'
import type { ComponentProps } from 'react'

export function PersonalIssueErrors(
  props: Omit<ComponentProps<typeof SharedPersonalIssueErrors>, 'translate'>
) {
  const { t } = useTranslation('common')
  return <SharedPersonalIssueErrors {...props} translate={key => t(key)} />
}
