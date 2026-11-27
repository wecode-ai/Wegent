import { PersonalIssuesView as SharedPersonalIssuesView } from '@wegent/collaboration/platform'
import type { ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { IndependentIssueDialog } from './IndependentIssueDialog'
import { useIndependentIssues } from './independentIssuesContext'
import { PersonalHomeIssueActivity } from './PersonalHomeIssueActivity'
import { subscribePersonalIssueChanges } from './personalHomeIssuesSource'

export function PersonalIssuesView(
  props: Omit<
    ComponentProps<typeof SharedPersonalIssuesView>,
    | 'independent'
    | 'language'
    | 'translate'
    | 'renderIndependentIssue'
    | 'renderActivity'
    | 'subscribeChanges'
  >
) {
  const { t, i18n } = useTranslation('common')
  const independent = useIndependentIssues()
  return (
    <SharedPersonalIssuesView
      {...props}
      independent={independent}
      language={i18n.language}
      translate={(key, options) => t(key, options)}
      renderActivity={activity => <PersonalHomeIssueActivity {...activity} />}
      subscribeChanges={subscribePersonalIssueChanges}
      renderIndependentIssue={drawer =>
        independent?.api ? (
          <IndependentIssueDialog
            key={drawer.issueId}
            {...drawer}
            api={independent.api}
            collaborationApi={independent.collaborationApi}
            userId={independent.userId}
            presentation="embedded"
          />
        ) : null
      }
    />
  )
}
