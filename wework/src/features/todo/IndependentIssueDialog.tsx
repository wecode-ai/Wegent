import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  IndependentIssueDialog as SharedIndependentIssueDialog,
  PersonalIssueTranslation,
  type IndependentIssueDialogProps,
} from '@wegent/collaboration/platform'
import { DefaultRunnerSetting } from '@/components/settings/DefaultRunnerSetting'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { useIndependentIssueTaskActions } from './useIndependentIssueTaskActions'
import { IssueProjectEnvironmentPicker } from './IssueProjectEnvironmentPicker'
import { SharedIssueSourceButton } from './SharedIssueSourceButton'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { TaskIssueShareFiles } from './TaskIssueShareFiles'

export function IndependentIssueDialog(
  props: Omit<
    IndependentIssueDialogProps,
    | 'api'
    | 'ShareFiles'
    | 'renderExecutionSettings'
    | 'renderDescriptionEditor'
    | 'translateIssueDetail'
    | 'taskActions'
    | 'attachments'
    | 'commentSendKey'
    | 'renderSourceAction'
    | 'saveAttachment'
  > & { api: PersonalIssuesApi }
) {
  const { t, i18n } = useTranslation('common')
  const translateDetail = createCollaborationTranslator(
    i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  )
  const { api, collaborationApi } = props
  const workbench = useWorkbench()
  const taskActions = useIndependentIssueTaskActions(api)
  return (
    <PersonalIssueTranslation.Provider value={(key, options) => t(key, options)}>
      <SharedIndependentIssueDialog
        {...props}
        ShareFiles={TaskIssueShareFiles}
        translateIssueDetail={translateDetail}
        attachments={
          collaborationApi?.attachments ?? workbench.services.sharedWorkspaceApi?.attachments
        }
        commentSendKey={workbench.state.user?.preferences?.send_key}
        saveAttachment={saveBlobToDownloads}
        renderDescriptionEditor={context => (
          <TaskDescriptionEditor
            testId={context.testId}
            value={context.value}
            ariaLabel={t('todo.issue_description_label')}
            placeholder={context.placeholder}
            onChange={context.onChange}
            readAttachment={context.readAttachment}
            onInlineAttachmentIdsChange={context.onInlineAttachmentIdsChange}
            disabled={!context.editable}
          />
        )}
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
        taskActions={taskActions}
        renderSourceAction={(issueId, onOpen) => (
          <SharedIssueSourceButton api={api} issueId={issueId} onOpen={onOpen} />
        )}
      />
    </PersonalIssueTranslation.Provider>
  )
}
