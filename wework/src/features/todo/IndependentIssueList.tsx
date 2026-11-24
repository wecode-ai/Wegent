import { IndependentIssueList as SharedIndependentIssueList } from '@wegent/collaboration/platform'
import type { ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { useIndependentIssuePage } from './useIndependentIssuePage'

export function IndependentIssueList({
  state,
  onOpenIssue,
  selectedId,
  ...props
}: Pick<ComponentProps<typeof SharedIndependentIssueList>, 'hideWhenEmpty' | 'selectedId'> & {
  state: ReturnType<typeof useIndependentIssuePage>
  onOpenIssue?(id: string): void
}) {
  const { t, i18n } = useTranslation('common')
  if (!state.context?.api) return null

  return (
    <SharedIndependentIssueList
      {...props}
      state={state}
      userId={state.context.userId}
      locale={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
      translate={key => t(key)}
      selectedId={selectedId ?? state.context.selectedId}
      onOpenIssue={onOpenIssue ?? state.context.open}
    />
  )
}
