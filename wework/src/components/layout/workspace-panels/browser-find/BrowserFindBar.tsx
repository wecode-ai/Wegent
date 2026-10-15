import { ContentFindBar } from '@/components/common/ContentFindBar'
import { useTranslation } from '@/hooks/useTranslation'
import type { BrowserFindState } from './browser-find-store'

export function BrowserFindBar(props: {
  query: string
  result: BrowserFindState | null
  unavailable: boolean
  onQueryChange: (query: string) => void
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <ContentFindBar
      {...props}
      onEnter={props.onStep}
      testIdPrefix="workspace-browser-find"
      inputLabel={t('workbench.browser_find_in_page')}
      placeholder={t('workbench.browser_find_placeholder')}
    />
  )
}
