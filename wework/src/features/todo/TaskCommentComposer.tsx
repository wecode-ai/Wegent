import { type IssueMentionGroup, IssueMainCommentComposer } from '@wegent/collaboration'
import { useContext } from 'react'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import type { ProjectChatMention } from '@/api/backend/projectChatSocket'
import { AttachmentBadges } from '@/components/chat/composer/AttachmentBadges'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { ProjectWorkBar } from '@/components/chat/composer/ProjectWorkBar'
import { PermissionModeSelector } from '@/components/chat/composer/PermissionModeSelector'
import {
  RUNTIME_PERMISSION_MODE_OPTION,
  runtimePermissionMode,
} from '@/features/workbench/runtimePermissionMode'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'

export function TaskCommentComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  error,
  mentionGroups,
  controls,
  projectWork,
  serverExecution = false,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: (mentions: ProjectChatMention[]) => void
  disabled: boolean
  sending: boolean
  error: string | null
  mentionGroups?: IssueMentionGroup[]
  controls: ProjectChatControls
  projectWork: ProjectWorkControls
  serverExecution?: boolean
}) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const sendKey = workbench?.state?.user?.preferences?.send_key ?? 'enter'
  return (
    <IssueMainCommentComposer
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      disabled={disabled}
      sending={sending}
      uploading={controls.uploadingFiles.size > 0}
      error={error}
      sendKey={sendKey}
      mentionGroups={mentionGroups}
      labels={{
        placeholder: t('workbench.task_activity_placeholder'),
        send: t('workbench.send_message'),
        attach: t('workbench.task_activity_attachment_attach'),
        settings: t('workbench.task_activity_execution_settings'),
      }}
      onSelectFiles={controls.handleFileSelect}
      attachments={
        <AttachmentBadges
          attachments={controls.attachments}
          uploadingFiles={controls.uploadingFiles}
          errors={controls.errors}
          onRemoveAttachment={controls.removeAttachment}
        />
      }
      settings={
        serverExecution ? undefined : (
          <>
            {projectWork.projects.length > 0 ? (
              <ProjectWorkBar
                {...projectWork}
                showClearButton={projectWork.showProjectClearButton}
              />
            ) : null}
            <ModelSelector
              models={controls.models}
              selectedModel={controls.selectedModel}
              selectedModelOptions={controls.selectedModelOptions}
              disabled={disabled || sending}
              onSelectModel={controls.setSelectedModel}
              onSelectModelOption={controls.setSelectedModelOption}
            />
            <PermissionModeSelector
              value={runtimePermissionMode(controls.selectedModelOptions)}
              disabled={disabled || sending}
              onChange={mode =>
                controls.setSelectedModelOption(RUNTIME_PERMISSION_MODE_OPTION, mode)
              }
            />
          </>
        )
      }
    />
  )
}
