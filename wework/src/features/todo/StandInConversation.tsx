import { PersonalPipelineConfirmation } from '@/components/chat/PersonalPipelineConfirmation'
import { standInConversationTaskId, type StandInConversationScope } from '@/api/personalStandIn'
import { useWorkbenchTaskReminders } from '@/features/workbench/runtimeTaskReminders'
import type { PersonalAssistantDefinition } from '@/api/personalAssistantAccount'
import type { StandInExecutorApi } from '@/api/standIn'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { Button } from '@/components/ui/button'
import { applyRuntimeConversationAction } from '@/features/workbench/runtimeConversationCache'
import { useRuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
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
import { StandInSidebarTaskList, type StandInSidebarTasks } from './StandInSidebarTaskList'
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
  sidebarTasks,
  renderDetails,
  settings,
  services,
  scope,
  definition,
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
  sidebarTasks?: StandInSidebarTasks
  renderDetails?(activeBranches: ReturnType<typeof activeStandInBranchRows>): ReactNode
  settings?: Pick<WorkspaceStandInSettings, 'model' | 'modelOptions'>
  services?: WorkbenchServices
  scope?: StandInConversationScope
  definition?: PersonalAssistantDefinition
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
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const { items: taskReminderItems } = useWorkbenchTaskReminders()
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
  const showModelSelector = scope === 'collaboration'
  const conversationModelControls =
    !showModelSelector && modelControls.unavailable
      ? {
          ...modelControls,
          unavailableReason: undefined,
          error: t('standIn.errors.conversation_profile_model_unavailable'),
        }
      : modelControls
  const aliases = getUnambiguousWorkbenchDeviceAliases(workbench?.state.devices ?? [])
  const pipelineTask = taskReminderItems.find(
    item =>
      item.address.taskId === taskId &&
      (aliases.get(item.address.deviceId) ?? item.address.deviceId) ===
        (aliases.get(deviceId) ?? deviceId)
  )
  const persistedTaskExists = Boolean(pipelineTask)
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
  const roleDelegationEnabled = scope !== 'collaboration' && !scope?.startsWith('shared:')
  const remoteBranches = useSyncExternalStore(
    active && roleDelegationEnabled && address ? roleBranches.subscribe : subscribeIdleResource,
    roleBranches.getSnapshot,
    getIdleResourceSnapshot
  )
  const delegatedWork = !roleDelegationEnabled
    ? []
    : selectStandInDelegatedWork(
        taskReminderItems,
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
  const renderDelegation = (group: (typeof groups)[number], inSidebar = false) => {
    const expansionKey = `${inSidebar ? 'panel' : 'message'}:${group.root}`
    return (
      <StandInDelegatedWork
        key={group.root}
        branches={group.branches}
        inSidebar={inSidebar}
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
        contentFooter={
          <>
            {address && (
              <PersonalPipelineConfirmation
                handle={pipelineTask?.task.runtimeHandle}
                address={address}
                services={services ?? workbench?.services}
              />
            )}
            {contentFooter}
          </>
        }
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
        showModelSelector={showModelSelector}
        composerHeader={
          !showModelSelector && modelControls.unavailable && !modelControls.loading ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 self-start md:min-h-8"
              data-testid="stand-in-conversation-model-retry"
              onClick={modelControls.refreshModelCatalog}
            >
              {t('standIn.errors.reload_conversation_models')}
            </Button>
          ) : null
        }
        hideProcessing
        showActivityDots
        markReadWhenActive
        nativeConversation
        runtimeContext={
          definition ? { assistantPrompt: definition.ghost.spec.systemPrompt } : undefined
        }
        allowMessagesDuringApproval
        modelControls={conversationModelControls}
        expanded
        active={active}
        placeholder={t(
          scope === 'collaboration'
            ? 'personalHome.conversationPrompt'
            : scope?.startsWith('team:')
              ? 'standIn.teams.prompt'
              : roleId
                ? 'standIn.workspace.role_prompt'
                : 'standIn.workspace.primary_prompt'
        )}
        emptyStateText={t(
          scope === 'collaboration'
            ? 'personalHome.conversationEmpty'
            : scope?.startsWith('team:')
              ? 'standIn.teams.empty_conversation'
              : hasPendingWork
                ? 'standIn.workspace.pending_work_help'
                : roleId
                  ? 'standIn.workspace.role_empty'
                  : 'standIn.workspace.primary_empty'
        )}
        onOpenRuntimeTask={onOpenTask}
        createTask={async (message, options) => {
          const target = { deviceId, taskId }
          applyRuntimeConversationAction(target, {
            type: 'user_added',
            message: options.optimisticUserMessage,
          })
          lifecycleStore.sendRequested(target)
          options.onRuntimeTaskOptimisticOpen(target)
          try {
            const result = await api.conversation(userId, deviceId, message, roleId, {
              ...options.executionModel,
              ...(scope ? { conversationScope: scope } : {}),
              ...(definition ? { assistantPrompt: definition.ghost.spec.systemPrompt } : {}),
              attachments: localRuntimeAttachments(options.attachments),
              clientUserMessageId: options.optimisticUserMessage.id,
            })
            lifecycleStore.sendAccepted(target)
            setAddress(result)
            return result
          } catch (cause) {
            lifecycleStore.sendRejected(target)
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
          <StandInSidebarTaskList
            tasks={sidebarTasks}
            delegations={groups.map(group => ({
              key: group.root,
              createdAt: group.createdAt,
              content: renderDelegation(group, true),
            }))}
            onOpenTask={onOpenTask}
          />
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
            deviceId: result.deviceId ?? deviceId,
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
