import type { ReactNode } from 'react'
import { IssueActivityContent } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'

export function TaskActivityContent(props: { messageId: string; children: ReactNode }) {
  const { t } = useTranslation('common')
  return (
    <IssueActivityContent
      {...props}
      expandLabel={t('workbench.task_activity_expand_content')}
      collapseLabel={t('workbench.task_activity_collapse_content')}
    />
  )
}
