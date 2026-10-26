import { useEffect, useMemo } from 'react'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { requestUserInputPayloadKey } from '@/components/chat/requestUserInputMessages'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import { useWorkbenchPaneSession } from '@/components/layout/useWorkbenchPaneSession'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

/** The list answers the same runtime request as the conversation, without opening a task. */
export function StandInWorkConfirmation({ address }: { address: RuntimeTaskAddress }) {
  const { t } = useTranslation('common')
  const { subscribeRuntimeTaskStream } = useWorkbenchPaneContext()
  const stableAddress = useMemo<RuntimeTaskAddress>(
    () => ({
      deviceId: address.deviceId,
      taskId: address.taskId,
      runtime: address.runtime,
      threadId: address.threadId,
      workspacePath: address.workspacePath,
      workspaceKind: address.workspaceKind,
      worktreeId: address.worktreeId,
      runtimeHandle: address.runtimeHandle,
      issueExecution: address.issueExecution,
      projectSession: address.projectSession,
    }),
    [
      address.deviceId,
      address.taskId,
      address.runtime,
      address.threadId,
      address.workspacePath,
      address.workspaceKind,
      address.worktreeId,
      address.runtimeHandle,
      address.issueExecution,
      address.projectSession,
    ]
  )
  const session = useWorkbenchPaneSession({
    currentRuntimeTask: stableAddress,
    debugSnapshotEnabled: false,
  })
  useEffect(
    () => subscribeRuntimeTaskStream(stableAddress, { onMessageAction: () => undefined }),
    [stableAddress, subscribeRuntimeTaskStream]
  )
  const pending = pendingRequestUserInputPayload(
    session.messages,
    session.answeredRequestUserInputIds
  )
  const summary = [...session.messages].reverse().find(message => message.role === 'assistant')
  return (
    <div className="mt-5 min-w-0" data-testid="stand-in-work-confirmation">
      {session.transcriptError && (
        <div role="alert" className="mb-3 text-sm text-error">
          <p>{session.transcriptError}</p>
          <button
            type="button"
            data-testid="stand-in-confirmation-retry"
            className="mt-2 underline"
            onClick={() => void session.reloadRuntimeTranscript()}
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      {pending && (
        <>
          {summary?.content && (
            <p className="mb-3 whitespace-pre-wrap break-words text-sm">{summary.content}</p>
          )}
          <RequestUserInputCard
            key={requestUserInputPayloadKey(pending)}
            payload={pending}
            messages={session.messages}
            compact
            onSubmit={session.sendRequestUserInputResponse}
            onIgnore={() => void session.ignoreRequestUserInput(pending)}
          />
        </>
      )}
      {session.error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {session.error}
        </p>
      )}
    </div>
  )
}
