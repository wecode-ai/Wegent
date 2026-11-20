import {
  IndependentIssueDialog as SharedIndependentIssueDialog,
  PersonalIssueTranslation,
  type IndependentIssueDialogProps,
} from '@wegent/collaboration/platform'
import { DefaultRunnerSetting } from '@/components/settings/DefaultRunnerSetting'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueTaskButton } from './IndependentIssueTaskButton'
import { IssueProjectEnvironmentPicker } from './IssueProjectEnvironmentPicker'
import { SharedIssueSourceButton } from './SharedIssueSourceButton'
import { TaskIssueShareFiles } from './TaskIssueShareFiles'

export function IndependentIssueDialog(
  props: Omit<
    IndependentIssueDialogProps,
    | 'api'
    | 'ShareFiles'
    | 'renderExecutionSettings'
    | 'renderTaskAction'
    | 'renderSourceAction'
    | 'saveAttachment'
  > & { api: PersonalIssuesApi }
) {
  const { t } = useTranslation('common')
  const { api, collaborationApi } = props
  return (
    <PersonalIssueTranslation.Provider value={(key, options) => t(key, options)}>
      <SharedIndependentIssueDialog
        {...props}
        ShareFiles={TaskIssueShareFiles}
        saveAttachment={saveBlobToDownloads}
        renderExecutionSettings={(projectId, busy) =>
          projectId && collaborationApi ? (
            <IssueProjectEnvironmentPicker
              key={projectId}
              api={collaborationApi}
              projectId={projectId}
              disabled={busy}
            />
          ) : (
            <DefaultRunnerSetting compact confirmChanges />
          )
        }
        renderTaskAction={(issue, onError) => (
          <IndependentIssueTaskButton api={api} issue={issue} onError={onError} />
        )}
        renderSourceAction={(issueId, onOpen) => (
          <SharedIssueSourceButton api={api} issueId={issueId} onOpen={onOpen} />
        )}
      />
    </PersonalIssueTranslation.Provider>
  )
}
