import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useStandInOpened } from '@/telemetry/useStandInOpened'
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { standInConversationTaskId } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { localRuntimeAttachments } from '@/lib/runtime-attachments'

export function StandInConversation({
  api,
  userId,
  deviceId,
  roleId,
  onOpenTask,
  active = true,
  hasPendingWork = false,
  draftRequest,
  onDraftRequestConsumed,
  contentFooter,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  roleId?: string
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  active?: boolean
  hasPendingWork?: boolean
  draftRequest?: { id: number; text: string }
  onDraftRequestConsumed?(id: number): void
  contentFooter?: ReactNode
}) {
  useStandInOpened('conversation', roleId ? 'role' : 'primary', active)
  const { t } = useTranslation('common')
  const [address, setAddress] = useState<RuntimeTaskAddress | null>()
  const [failure, setFailure] = useState<{
    api: StandInExecutorApi
    deviceId: string
    taskId: string
    message: string
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const taskId = standInConversationTaskId(userId, roleId)
  const workbench = useContext(WorkbenchContext)
  const aliases = getUnambiguousWorkbenchDeviceAliases(workbench?.state.devices ?? [])
  const persistedTaskExists = Boolean(
    workbench?.runtimeTaskReminders.items.some(
      item =>
        item.address.taskId === taskId &&
        (aliases.get(item.address.deviceId) ?? item.address.deviceId) ===
          (aliases.get(deviceId) ?? deviceId)
    )
  )
  const error =
    failure?.api === api && failure.deviceId === deviceId && failure.taskId === taskId
      ? failure.message
      : null
  useEffect(() => {
    let active = true
    api
      .readTask(deviceId, taskId)
      .then(result => {
        if (active) {
          setAddress(
            result.task
              ? {
                  deviceId,
                  taskId,
                  runtime: result.task.runtime,
                  threadId: result.task.threadId,
                  workspacePath: result.task.workspacePath,
                  workspaceKind: result.task.workspaceKind,
                  runtimeHandle: result.task.runtimeHandle,
                }
              : null
          )
          setFailure(null)
        }
      })
      .catch(cause => {
        if (active) setFailure({ api, deviceId, taskId, message: getStandInErrorMessage(cause) })
      })
    return () => {
      active = false
    }
  }, [api, deviceId, taskId, attempt, persistedTaskExists])
  const failureNotice = error ? (
    <div role="alert" className="p-5 text-sm text-error">
      <p>{error}</p>
      <button
        type="button"
        data-testid="stand-in-conversation-retry"
        className="mt-2 underline"
        onClick={() => {
          setFailure(null)
          setAttempt(value => value + 1)
        }}
      >
        {t('standIn.reload')}
      </button>
    </div>
  ) : null
  if (error && address === undefined) return failureNotice
  if (address === undefined)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('standIn.loading')}
      </p>
    )
  return (
    <>
      {failureNotice}
      <TemporaryChatPanel
        key={taskId}
        currentProject={null}
        source={null}
        instanceId={`stand-in:${deviceId}:${taskId}`}
        testId="stand-in-conversation"
        draftRequest={draftRequest}
        contentFooter={contentFooter}
        onDraftRequestConsumed={onDraftRequestConsumed}
        initialAddress={address}
        controlledAddress={address}
        onAddressChange={setAddress}
        sendEphemeral={false}
        crossProviderSwitchBehavior="new-session"
        showExecutionTools={false}
        hideProcessing
        assistantMessageStyle="bubble"
        markReadWhenActive
        nativeConversation
        expanded
        active={active}
        placeholder={t(
          roleId ? 'standIn.workspace.role_prompt' : 'standIn.workspace.primary_prompt'
        )}
        emptyStateText={t(
          hasPendingWork
            ? 'standIn.workspace.pending_work_help'
            : roleId
              ? 'standIn.workspace.role_empty'
              : 'standIn.workspace.primary_empty'
        )}
        onOpenRuntimeTask={onOpenTask}
        createTask={async (message, options) => {
          const target = { deviceId, taskId }
          options.onRuntimeTaskOptimisticOpen(target)
          try {
            const result = await api.conversation(userId, deviceId, message, roleId, {
              ...options.executionModel,
              attachments: localRuntimeAttachments(options.attachments),
              clientUserMessageId: options.optimisticUserMessage.id,
            })
            setAddress(result)
            return result
          } catch (cause) {
            options.onError(getStandInErrorMessage(cause))
            return false
          }
        }}
      />
    </>
  )
}
