import { useEffect, useState } from 'react'
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
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  roleId?: string
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  active?: boolean
}) {
  const { t } = useTranslation('common')
  const [address, setAddress] = useState<RuntimeTaskAddress | null>()
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const taskId = standInConversationTaskId(userId, roleId)
  useEffect(() => {
    let active = true
    api
      .readTask(deviceId, taskId)
      .then(result => {
        if (active) setAddress(result.task ? { deviceId, taskId } : null)
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [api, deviceId, taskId, attempt])
  if (error)
    return (
      <div role="alert" className="p-5 text-sm text-error">
        <p>{error}</p>
        <button
          type="button"
          data-testid="stand-in-conversation-retry"
          className="mt-2 underline"
          onClick={() => {
            setError(null)
            setAddress(undefined)
            setAttempt(value => value + 1)
          }}
        >
          {t('standIn.reload')}
        </button>
      </div>
    )
  if (address === undefined)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('standIn.loading')}
      </p>
    )
  return (
    <TemporaryChatPanel
      key={taskId}
      currentProject={null}
      source={null}
      instanceId={`stand-in:${deviceId}:${taskId}`}
      testId="stand-in-conversation"
      initialAddress={address}
      sendEphemeral={false}
      expanded
      active={active}
      placeholder={t(roleId ? 'standIn.workspace.role_prompt' : 'standIn.workspace.primary_prompt')}
      emptyStateText={t(
        roleId ? 'standIn.workspace.role_empty' : 'standIn.workspace.primary_empty'
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
          options.onError(String(cause))
          return false
        }
      }}
    />
  )
}
