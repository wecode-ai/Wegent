import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { useStandInConversationModel } from '@/features/todo/useStandInConversationModel'
import { localRuntimeAttachments } from '@/lib/runtime-attachments'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { recordAcceptedAssistantConversation } from './acceptedAssistantConversations'
import { IssueDetailSearchableSelect } from '@wegent/collaboration'
import { useExperienceDraftInput } from '../useExperienceDraftInput'

export interface AssistantComposerProps {
  active: boolean
  settings: PersonalStandInSettings
  onCreated(address: RuntimeTaskAddress, title: string): void
}

export function AssistantComposer(props: AssistantComposerProps) {
  const { state } = useWorkbench()
  const connection = useOptionalCloudConnection()
  const accountKey = workbenchOwnershipKey(connection, state.user)
  const [selection, setSelection] = useState({
    accountKey,
    userId: props.settings.userId,
    roleId: '',
  })
  const selectedRoleId =
    selection.accountKey === accountKey && selection.userId === props.settings.userId
      ? selection.roleId
      : ''
  const role = props.settings.roles.find(item => item.id === selectedRoleId)
  const deviceId = role?.executionDeviceId || props.settings.executionDeviceId
  return (
    <AssistantComposerSession
      key={JSON.stringify([accountKey, props.settings.userId, deviceId, role?.id ?? null])}
      {...props}
      accountKey={accountKey}
      roleId={role?.id}
      onRoleChange={roleId => setSelection({ accountKey, userId: props.settings.userId, roleId })}
    />
  )
}

function AssistantComposerSession({
  active,
  settings,
  onCreated,
  accountKey,
  roleId,
  onRoleChange,
}: AssistantComposerProps & {
  accountKey: string
  roleId?: string
  onRoleChange(id: string): void
}) {
  const { t } = useTranslation('collaborationExp')
  const { services, projectChat, refreshWorkLists } = useWorkbench()
  const role = settings.roles.find(item => item.id === roleId)
  const deviceId = role?.executionDeviceId || settings.executionDeviceId
  const scopeKey = JSON.stringify([
    'collaboration-exp-assistant',
    accountKey,
    settings.userId,
    deviceId,
    ...(role ? [role.id] : []),
  ])
  const draft = useExperienceDraftInput({
    accountKey,
    scopeKey,
    initialValue: projectChat.inputByScope[scopeKey] ?? '',
    onChange: next => projectChat.setInputForScope(scopeKey, next),
  })
  const { value, setValue } = draft
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const pageActive = useRef(active)
  useLayoutEffect(() => {
    pageActive.current = active
    return () => {
      pageActive.current = false
    }
  }, [active])
  const attachments = useWorkbenchAttachments({
    scopeKey,
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
  })
  const controls = useStandInConversationModel(
    services,
    {
      ...(role ?? settings.primary),
      enabled: true,
      prompt: '',
      version: settings.version,
      executionDeviceId: deviceId,
    },
    active
  )
  const unavailable = controls.loading || controls.unavailable || !services.standInApi

  const submit = async (content = value) => {
    if (
      !active ||
      !content.trim() ||
      submittingRef.current ||
      unavailable ||
      !attachments.isAttachmentReadyToSend ||
      attachments.errors.size
    )
      return false
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    let submission: ReturnType<typeof draft.beginSubmission> | undefined
    try {
      submission = draft.beginSubmission(content)
      const address = await services.standInApi!.conversation(
        settings.userId,
        deviceId,
        content.trim(),
        role?.id,
        {
          ...selectedModelExecutionFields(controls.selectedModel, controls.selectedModelOptions),
          attachments: localRuntimeAttachments(attachments.attachments),
          clientUserMessageId: submission.clientMessageId,
        }
      )
      recordAcceptedAssistantConversation(accountKey, settings.userId, address, content.trim())
      submission.clearIfUnchanged()
      attachments.resetAttachments()
      void refreshWorkLists().catch(cause => setError(getStandInErrorMessage(cause)))
      if (pageActive.current) onCreated(address, content.trim())
      return true
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
      return false
    } finally {
      submission?.release()
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <BufferedChatInput
      value={value}
      onChange={next => {
        setValue(next)
        setError(null)
        return { appliedSynchronously: true }
      }}
      onDraftEdit={setValue}
      onSubmit={submit}
      disabled={!active || submitting}
      submitDisabled={
        unavailable || !attachments.isAttachmentReadyToSend || attachments.errors.size > 0
      }
      error={
        error ?? (draft.persistenceError ? t('assistant.draftPersistenceFailed') : controls.error)
      }
      placeholder={t('assistant.placeholder')}
      inputTestId="collaboration-exp-assistant-input"
      submitButtonTestId="collaboration-exp-assistant-send"
      showExecutionTools={false}
      showModelSelector
      toolbarLeadingContext={
        <>
          <IssueDetailSearchableSelect
            value={role ? JSON.stringify([role.id]) : 'auto'}
            options={[
              { value: 'auto', label: t('assistant.automatic') },
              ...settings.roles.map(item => ({
                value: JSON.stringify([item.id]),
                label: item.name || t('assistant.specialist'),
              })),
            ]}
            accessibleLabel={t('assistant.chooseRole')}
            searchPlaceholder={t('assistant.chooseRole')}
            emptyLabel={t('tasks.noMatches')}
            testId="collaboration-exp-assistant-role-select"
            className="assistant-role-select text-xs"
            triggerContent={
              <>
                <span>{role?.name || t('assistant.automatic')}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </>
            }
            disabled={!active || submitting}
            onChange={value =>
              onRoleChange(
                settings.roles.find(item => JSON.stringify([item.id]) === value)?.id ?? ''
              )
            }
          />
          <small className="assistant-private-label">{t('assistant.privateScope')}</small>
        </>
      }
      variant="desktop"
      requireText
      projectChat={{
        ...projectChat,
        ...attachments,
        ...controls,
        scopeKey,
        isOptionsLocked: false,
      }}
    />
  )
}
