import { useEffect } from 'react'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { useActivityExecutionDisplayStatus } from './useActivityExecutionStatus'
import { RuntimeExecutionConversation, createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopToolServices } from '@/components/chat/DesktopToolServices'
import { useDesktopConversationPresentation } from '@/components/chat/useDesktopConversationPresentation'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchPaneSession } from '@/components/layout/useWorkbenchPaneSession'
import {
  findRuntimeTask,
  truncateRuntimeTaskTitle,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import type { RuntimeTaskAddress } from '@/types/api'

export interface RuntimeTaskExecutionOverlayProps {
  address: RuntimeTaskAddress
  activityMessage?: ProjectChatMessage
  executionTurnId?: string
  singleExecution?: boolean
  onExecutionTurnIdentified?: (turnId: string) => void
  senderName: string
  runId?: string | null
  modelName?: string | null
  runStatus?: string | null
  onClose: () => void
}

export function RuntimeTaskExecutionOverlay({
  address,
  activityMessage,
  executionTurnId,
  singleExecution = false,
  onExecutionTurnIdentified,
  senderName,
  runId,
  modelName,
  runStatus,
  onClose,
}: RuntimeTaskExecutionOverlayProps) {
  const { i18n } = useTranslation('common')
  const presentation = useDesktopConversationPresentation()
  const { state, cancelRuntimeTask, openRuntimeTask } = useWorkbenchPaneContext()
  const session = useWorkbenchPaneSession({
    currentRuntimeTask: address,
    debugSnapshotEnabled: false,
  })
  const { turn, status: executionStatus } = useActivityExecutionDisplayStatus(
    activityMessage,
    executionTurnId,
    singleExecution &&
      !session.transcriptLoading &&
      !session.transcriptError &&
      !session.transcriptHasMoreBefore &&
      session.loadedTranscriptRanges.some(range => range.start === 0)
  )
  useEffect(() => {
    if (turn?.id) onExecutionTurnIdentified?.(turn.id)
  }, [turn?.id, onExecutionTurnIdentified])
  const task = findRuntimeTask(state.runtimeWork, address)
  const device = findWorkbenchDevice(state.devices, address.deviceId)
  return (
    <DesktopToolServices>
      <RuntimeExecutionConversation
        senderName={senderName}
        taskTitle={truncateRuntimeTaskTitle(task?.title)}
        runId={runId ?? String(address.taskId)}
        modelName={task?.modelSelection?.modelName ?? modelName ?? '—'}
        deviceName={device?.name ?? address.deviceId}
        runStatus={
          executionStatus ??
          (activityMessage
            ? runStatus
            : session.status.taskExecution.running
              ? 'running'
              : (task?.status ?? runStatus))
        }
        transcriptError={session.transcriptError}
        transcriptUnavailable={
          session.messages.length === 0 &&
          Boolean(
            session.transcriptError ||
            (!session.transcriptLoading && !session.status.taskExecution.running)
          )
        }
        onRetryTranscript={session.reloadRuntimeTranscript}
        executionRunning={
          session.status.taskExecution.running
            ? true
            : session.transcriptError || session.transcriptLoading
              ? undefined
              : false
        }
        onStop={async () => {
          await cancelRuntimeTask(address)
          await session.reloadRuntimeTranscript()
        }}
        onOpenTask={() => openRuntimeTask(address)}
        onClose={onClose}
        translate={createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')}
        conversation={{
          ...presentation,
          messages: session.messages,
          loading: session.transcriptLoading,
          isWaitingForAssistant: session.waitingForAssistant,
          hasMoreBefore: session.transcriptHasMoreBefore,
          loadingMoreBefore: session.transcriptLoadingMoreBefore,
          turnNavigation: session.turnNavigation,
          loadedTranscriptRanges: session.loadedTranscriptRanges,
          onLoadMoreBefore: session.loadMoreTranscriptBefore,
          onLoadTurnNavigationItem: session.loadTranscriptTurnNavigationItem,
          onLoadTranscriptGap: session.loadTranscriptGap,
          conversationKey: `${address.deviceId}:${address.taskId}`,
          devices: state.devices,
        }}
      />
    </DesktopToolServices>
  )
}
