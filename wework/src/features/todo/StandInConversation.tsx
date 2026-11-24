import { standInConversationTaskId } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { localRuntimeAttachments } from '@/lib/runtime-attachments'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import { createStandInOpenedReceipt } from '@/telemetry/standInOpenedReceipt'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { WorkspaceStandInSettings } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  activeStandInBranchRows,
  groupStandInDelegations,
  selectStandInDelegatedWork,
  standInDelegationsByMessage,
} from './standInDelegatedBranches'
import { StandInDelegatedWork } from './StandInDelegatedWork'
import { useStandInConversationModel } from './useStandInConversationModel'

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
  delegationPanelOpen,
  taskList,
  renderDetails,
  settings,
  services,
  scope,
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
  delegationPanelOpen?: boolean
  taskList?: ReactNode
  renderDetails?(activeBranches: ReturnType<typeof activeStandInBranchRows>): ReactNode
  settings?: Pick<WorkspaceStandInSettings, 'model' | 'modelOptions'>
  services?: WorkbenchServices
  scope?: 'collaboration'
}) {
  const [recordOpened] = useState(createStandInOpenedReceipt)
  const openedIdentity = roleId ? 'role' : 'primary'
  const { t } = useTranslation('common')
  const taskId = standInConversationTaskId(userId, roleId, scope)
  const [owner, setOwner] = useState(() => createConversationSource(api, deviceId, taskId))
  if (owner.api !== api || owner.deviceId !== deviceId || owner.taskId !== taskId) {
    const sameConversation = owner.deviceId === deviceId && owner.taskId === taskId
    setOwner(
      createConversationSource(
        api,
        deviceId,
        taskId,
        sameConversation ? owner.resource.getSnapshot().data : undefined
      )
    )
  }
  const resource = owner.resource
  const workbench = useContext(WorkbenchContext)
  const modelControls = useStandInConversationModel(
    services ?? workbench?.services,
    {
      ...settings,
      executionDeviceId: deviceId,
      enabled: true,
      prompt: '',
      version: 0,
    },
    active
  )
  const aliases = getUnambiguousWorkbenchDeviceAliases(workbench?.state.devices ?? [])
  const persistedTaskExists = Boolean(
    workbench?.runtimeTaskReminders.items.some(
      item =>
        item.address.taskId === taskId &&
        (aliases.get(item.address.deviceId) ?? item.address.deviceId) ===
          (aliases.get(deviceId) ?? deviceId)
    )
  )
  const subscribe = useCallback(
    (listener: () => void) => {
      const release = resource.subscribe(listener, persistedTaskExists)
      recordOpened('conversation', openedIdentity, active)
      return release
    },
    [resource, persistedTaskExists, recordOpened, openedIdentity, active]
  )
  const snapshot = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot)
  const address = snapshot.data
  const roleBranches = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify([userId, deviceId, taskId]),
        () => api.remoteRoleBranches(userId, deviceId, taskId),
        { refreshIntervalMs: 3000, refreshIntervalMode: 'after-settle', refreshOnSubscribe: true }
      ),
    [api, userId, deviceId, taskId]
  )
  const remoteBranches = useSyncExternalStore(
    active && !scope && address ? roleBranches.subscribe : subscribeIdleResource,
    roleBranches.getSnapshot,
    getIdleResourceSnapshot
  )
  const delegatedWork = scope
    ? []
    : selectStandInDelegatedWork(
        workbench?.runtimeTaskReminders.items ?? [],
        remoteBranches.data?.items ?? [],
        userId,
        deviceId,
        taskId,
        aliases
      )
  const error = snapshot.status === 'error' ? getStandInErrorMessage(snapshot.error) : null
  const setAddress = useCallback(
    (value: RuntimeTaskAddress | null) => {
      resource.update(() => value)
    },
    [resource]
  )
  const failureNotice = error ? (
    <div role="alert" className="p-5 text-sm text-error">
      <p>{error}</p>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="stand-in-conversation-retry"
        className="mt-2 underline"
        onClick={() => {
          void resource.reload()
        }}
      >
        {t('standIn.reload')}
      </ControlButton>
    </div>
  ) : null
  const [expandedDelegations, setExpandedDelegations] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const groups = groupStandInDelegations(delegatedWork)
  const delegationTitle = t('standIn.delegation.title')
  const renderDelegation = (group: (typeof groups)[number], showTitle = false) => {
    const expansionKey = `${showTitle ? 'panel' : 'message'}:${group.root}`
    return (
      <StandInDelegatedWork
        key={group.root}
        branches={group.branches}
        showTitle={showTitle}
        expanded={expandedDelegations.has(expansionKey)}
        onExpandedChange={expanded => {
          setExpandedDelegations(previous => {
            const next = new Set(previous)
            if (expanded) next.add(expansionKey)
            else next.delete(expansionKey)
            return next
          })
        }}
        taskId={taskId}
        onOpenTask={onOpenTask}
        onCancel={async (root, branch) => {
          await api.cancelRoleWork(
            userId,
            branch?.dispatcherDeviceId ?? deviceId,
            taskId,
            root,
            branch?.taskId
          )
          void roleBranches.reload()
        }}
        onRetry={async branch => {
          await api.retryRoleWork(
            userId,
            branch.dispatcherDeviceId,
            taskId,
            branch.root,
            branch.taskId,
            branch.attempt
          )
          await roleBranches.reload()
        }}
      />
    )
  }
  const details = renderDetails?.(activeStandInBranchRows(delegatedWork))
  const conversation =
    address === undefined ? (
      error ? null : (
        <p role="status" className="p-5 text-sm text-text-secondary">
          {t('standIn.loading')}
        </p>
      )
    ) : (
      <TemporaryChatPanel
        key={taskId}
        currentProject={null}
        source={null}
        instanceId={`stand-in:${deviceId}:${taskId}`}
        testId="stand-in-conversation"
        draftRequest={draftRequest}
        contentFooter={contentFooter}
        renderMessageGaps={
          groups.length
            ? messages =>
                new Map(
                  [...standInDelegationsByMessage(messages, groups)].map(
                    ([messageId, messageGroups]) => [
                      messageId,
                      messageGroups.map(group => renderDelegation(group)),
                    ]
                  )
                )
            : undefined
        }
        onDraftRequestConsumed={onDraftRequestConsumed}
        initialAddress={address}
        controlledAddress={address}
        onAddressChange={setAddress}
        sendEphemeral={false}
        showExecutionTools={false}
        hideProcessing
        assistantMessageStyle="bubble"
        markReadWhenActive
        nativeConversation
        modelControls={modelControls}
        expanded
        active={active}
        placeholder={t(
          scope === 'collaboration'
            ? 'personalHome.conversationPrompt'
            : roleId
              ? 'standIn.workspace.role_prompt'
              : 'standIn.workspace.primary_prompt'
        )}
        emptyStateText={t(
          scope === 'collaboration'
            ? 'personalHome.conversationEmpty'
            : hasPendingWork
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
              ...(scope ? { conversationScope: scope } : {}),
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
    )
  return (
    <>
      {failureNotice}
      <div className="flex min-h-0 flex-1">
        <div
          className={delegationPanelOpen ? 'hidden min-w-0 flex-1 md:flex' : 'flex min-w-0 flex-1'}
        >
          {conversation}
        </div>
        {delegationPanelOpen && (
          <aside
            id="stand-in-delegation-panel"
            aria-label={t('standIn.delegation.panel')}
            data-testid="stand-in-delegation-panel"
            className="flex min-w-0 flex-1 flex-col border-border bg-background md:w-80 md:flex-none md:border-l"
          >
            <h2 className="border-b border-border px-4 py-3 text-sm font-medium">
              {t('standIn.delegation.panel')}
            </h2>
            <div className="min-h-0 flex-1 overflow-y-auto px-3">
              <section aria-label={delegationTitle} className="pt-3">
                <h3 className="px-1 text-sm font-medium">{delegationTitle}</h3>
                {groups.length ? (
                  groups.toReversed().map(group => renderDelegation(group, true))
                ) : (
                  <p className="px-1 py-3 text-sm text-text-secondary">
                    {t('standIn.delegation.empty')}
                  </p>
                )}
              </section>
              {taskList}
            </div>
          </aside>
        )}
      </div>
      {details}
    </>
  )
}

/** API reconnects retain this conversation's accepted address while checking its metadata again. */
function createConversationSource(
  api: StandInExecutorApi,
  deviceId: string,
  taskId: string,
  initialData?: RuntimeTaskAddress | null
) {
  const resource = createAsyncResource<RuntimeTaskAddress | null>(
    JSON.stringify(['stand-in-conversation', deviceId, taskId]),
    async () => {
      const result = await api.readTask(deviceId, taskId)
      return result.task
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
    },
    { initialData }
  )
  return { api, deviceId, taskId, resource }
}
