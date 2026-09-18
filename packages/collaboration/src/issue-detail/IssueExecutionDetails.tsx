import { RuntimeDeviceAccessNotice } from '../conversation/RuntimeDeviceAccess'
import { useRuntimeDeviceAccess } from '../conversation/useRuntimeDeviceAccess'
import { RuntimeExecutionDetails } from './RuntimeExecutionDetails'
import type { CollaborationTranslate } from '../i18n'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { RuntimeExecutionTarget } from './runtimeExecutionTarget'
import { RuntimeExecutionConversation } from './RuntimeExecutionConversation'
import { MarkdownServicesProvider } from '../markdown'
import { useBrowserRuntimeConversation } from './useBrowserRuntimeConversation'
import { useIssueActivityExecutionStatus } from './useIssueActivityExecutionStatus'

/** Browser data adapter for the complete PC execution viewer. */
function IssueExecutionDetailsContent({
  target,
  runtime,
  translate,
  onClose,
}: {
  target: RuntimeExecutionTarget
  runtime: SharedWorkspaceRuntimeApi
  translate: CollaborationTranslate
  onClose(): void
}) {
  const { state, task, workspace, markdown, conversation, metadataError, actionError, reload } =
    useBrowserRuntimeConversation(runtime, target.address, translate)
  const { status: executionStatus } = useIssueActivityExecutionStatus(
    target.activityMessage,
    target.singleExecution,
    state
  )
  return (
    <MarkdownServicesProvider value={markdown}>
      <RuntimeExecutionConversation
        senderName={target.senderName}
        taskTitle={state.title ?? task?.title ?? target.taskTitle}
        runId={target.runId ?? target.address.taskId}
        modelName={task?.modelSelection?.modelName ?? target.modelName ?? '—'}
        deviceName={workspace?.deviceName ?? target.address.deviceId}
        runStatus={
          executionStatus ??
          (target.activityMessage
            ? target.runStatus
            : (state.runStatus ?? task?.status ?? target.runStatus))
        }
        transcriptUnavailable={
          !state.messages.length &&
          Boolean(
            state.error || state.historyUnavailable || (!state.loading && state.running === false)
          )
        }
        transcriptError={state.error ?? metadataError ?? actionError}
        onRetryTranscript={() => void reload()}
        executionRunning={state.running}
        onStop={async () => {
          await runtime.cancel(target.address)
          await reload()
        }}
        onClose={onClose}
        translate={translate}
        conversation={conversation}
      />
    </MarkdownServicesProvider>
  )
}

export function IssueExecutionDetails(props: Parameters<typeof IssueExecutionDetailsContent>[0]) {
  const { runtime, target, translate, onClose } = props
  const access = useRuntimeDeviceAccess(runtime, [target.address.deviceId])
  if (access.get(target.address.deviceId) === 'allowed')
    return <IssueExecutionDetailsContent {...props} />
  return (
    <RuntimeExecutionDetails
      senderName={target.senderName}
      taskTitle={target.taskTitle}
      runId={target.runId ?? target.address.taskId}
      modelName={target.modelName ?? '—'}
      deviceName={target.address.deviceId}
      runStatus={target.runStatus}
      onRetryTranscript={access.retry}
      onClose={onClose}
      translate={translate}
    >
      <RuntimeDeviceAccessNotice
        access={access.get(target.address.deviceId)}
        error={access.error}
        retry={access.retry}
        translate={translate}
      />
    </RuntimeExecutionDetails>
  )
}
