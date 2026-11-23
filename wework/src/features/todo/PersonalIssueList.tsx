import { PersonalIssueList as SharedPersonalIssueList } from '@wegent/collaboration/platform'
import type { ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { PersonalHomeIssueActivity } from './PersonalHomeIssueActivity'

export function PersonalIssueList(
  props: Omit<
    ComponentProps<typeof SharedPersonalIssueList>,
    'language' | 'translate' | 'renderActivity'
  >
) {
  const { t, i18n } = useTranslation('common')
  return (
    <SharedPersonalIssueList
      {...props}
      language={i18n.language}
      translate={(key, options) => t(key, options)}
      renderActivity={activity => <PersonalHomeIssueActivity {...activity} />}
    />
  )
}
