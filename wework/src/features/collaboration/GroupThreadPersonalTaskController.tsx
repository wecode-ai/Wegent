import { ThreadActionsContext, useGroupThreadActions } from './threadActionsContext'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { SharedIssueDetailTaskBinding } from '@wegent/collaboration'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { subscribeIssueDispatch } from '@/features/notifications/issueDispatch'
import type { IssueDispatchPersonalTaskAction } from '@/features/notifications/NotificationTaskSourceContext'
import { issueExecutionAddress } from '@/features/todo/collaborationTaskAddress'
import { issueRuntimeBindingPort } from '@/features/todo/issueRuntimeBindingPort'
import {
  useIssuePersonalTaskConversation,
  useIssuePersonalTaskState,
} from '@/features/todo/useIssuePersonalTaskConversation'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { CollaborationGroupsSurface } from './CollaborationGroupsSurface'
import type { ComponentProps } from 'react'
import type { ThreadActionContext } from './threadActions'
import {
  canStartThreadPersonalTask,
  hasThreadWorkOwner,
  threadActionOwner,
} from './threadPersonalTaskAccess'
import { ThreadWorkMetadata } from './ThreadWorkMetadata'
import { requireThreadHumanTaskStart } from './threadHumanTaskStart'
import { openThreadExecution } from './threadExecutionNavigation'
import type { ProjectChatMessage } from '@wegent/chat-core'

interface PersonalTaskIntent {
  owner: string
  context: ThreadActionContext
  key: string
  binding?: SharedIssueDetailTaskBinding
  dispatch?: IssueDispatchPersonalTaskAction
}
interface RuntimeProps {
  services: Pick<
    WorkbenchServices,
    | 'standInApi'
    | 'projectSpaceApis'
    | 'workspaceRuntimePort'
    | 'projectSpaceDetailServices'
    | 'chatGroupApis'
  >
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  onOpenRuntimeTask?(address: RuntimeTaskAddress): Promise<void> | void
}

export function GroupThreadSurface(props: ComponentProps<typeof CollaborationGroupsSurface>) {
  const actions = useGroupThreadActions()
  return (
    <CollaborationGroupsSurface
      {...props}
      renderThreadActions={actions?.renderThreadActions ?? props.renderThreadActions}
      onThreadActionContext={actions?.onThreadActionContext ?? props.onThreadActionContext}
    />
  )
}

/** Keep the private conversation alive independently of the metadata sheet. */
export function GroupThreadPersonalTaskController({
  owner,
  active,
  locale,
  deviceNamesById,
  children,
  ...runtime
}: RuntimeProps & {
  owner: string
  active: boolean
  locale: 'zh-CN' | 'en'
  deviceNamesById?: Readonly<Record<string, string>>
  children: ReactNode
}) {
  const { t } = useTranslation('common')
  const [intent, setIntent] = useState<PersonalTaskIntent | null>(null)
  const [visibleContext, setVisibleContext] = useState<ThreadActionContext | null>(null)
  const [notice, setNotice] = useState<{
    owner: string
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const [stateOwner, setStateOwner] = useState(owner)
  if (stateOwner !== owner) {
    setStateOwner(owner)
    setIntent(null)
    setVisibleContext(null)
    setNotice(null)
  }
  const currentActivity = useRef(active)
  useLayoutEffect(() => {
    currentActivity.current = active
  }, [active])
  const currentOwner = useRef<string | null>(owner)
  useLayoutEffect(() => {
    currentOwner.current = owner
    return () => {
      currentOwner.current = null
    }
  }, [owner])
  const clearNotice = useCallback(() => setNotice(null), [])
  const notify = useCallback(
    (message: string, tone: 'success' | 'error' = 'success') => {
      if (currentOwner.current === owner) setNotice({ owner, message, tone })
    },
    [owner]
  )
  const close = useCallback(() => setIntent(null), [])
  const request = useCallback(
    (
      context: ThreadActionContext,
      binding?: SharedIssueDetailTaskBinding,
      dispatch?: IssueDispatchPersonalTaskAction
    ) => {
      const actor = context.participation?.current_user_id
      if (
        currentOwner.current !== owner ||
        threadActionOwner(context) !== owner ||
        !hasThreadWorkOwner(context) ||
        actor === undefined
      )
        return
      if (
        binding &&
        (String(binding.task_user_id) !== String(actor) ||
          String(binding.cloud_project_id) !== context.group.id ||
          String(binding.loop_item_id) !== context.item.id)
      )
        return
      context.requestLeave(() => {
        if (currentOwner.current === owner)
          setIntent({ owner, context, binding, dispatch, key: crypto.randomUUID() })
      })
    },
    [owner]
  )
  const onThreadActionContext = useCallback(
    (context: ThreadActionContext | null) => {
      if (currentOwner.current !== owner) return
      if (context && (threadActionOwner(context) !== owner || !hasThreadWorkOwner(context))) return
      setVisibleContext(previous => {
        if (!context) return null
        if (
          previous &&
          threadActionOwner(previous) === owner &&
          previous.api === context.api &&
          previous.group.version === context.group.version &&
          previous.group.role === context.group.role &&
          previous.group.status === context.group.status &&
          previous.item.version === context.item.version &&
          previous.participation === context.participation
        )
          return previous
        return context
      })
      if (!context) setIntent(null)
    },
    [owner]
  )
  useEffect(() => {
    if (
      !active ||
      !visibleContext ||
      threadActionOwner(visibleContext) !== owner ||
      !canStartThreadPersonalTask(visibleContext)
    )
      return
    return subscribeIssueDispatch({
      shows: action =>
        action.itemId === visibleContext.item.id &&
        String(action.projectId) === visibleContext.group.id,
      answer: action => request(visibleContext, undefined, action),
    })
  }, [active, owner, request, visibleContext])
  const openExecution = useCallback(
    async (context: ThreadActionContext, message: ProjectChatMessage) => {
      if (!runtime.onOpenRuntimeTask) throw new Error(t('todo.linked_task_unavailable'))
      await openThreadExecution({
        context,
        message,
        open: runtime.onOpenRuntimeTask,
        unavailable: t('todo.linked_task_unavailable'),
        isCurrent: () =>
          currentOwner.current === owner &&
          currentActivity.current &&
          threadActionOwner(context) === owner,
      })
    },
    [runtime.onOpenRuntimeTask, owner, t]
  )
  const renderThreadActions = useCallback(
    (context: ThreadActionContext) =>
      threadActionOwner(context) === owner ? (
        <ThreadWorkMetadata
          context={context}
          locale={locale}
          onCreate={value => request(value)}
          onOpen={request}
          runtimeWork={runtime.runtimeWork}
          runtimeTaskLifecycle={runtime.runtimeTaskLifecycle}
          deviceNamesById={deviceNamesById}
        />
      ) : null,
    [owner, locale, request, runtime.runtimeWork, runtime.runtimeTaskLifecycle, deviceNamesById]
  )
  return (
    <>
      <ThreadActionsContext
        value={{
          renderThreadActions,
          onThreadActionContext,
          ...(runtime.onOpenRuntimeTask ? { openExecution } : {}),
        }}
      >
        {children}
      </ThreadActionsContext>
      {intent?.owner === owner && (
        <ThreadPersonalTaskPanel
          key={intent.key}
          intent={intent}
          active={active}
          {...runtime}
          notify={notify}
          clearNotice={clearNotice}
          onClosed={close}
        />
      )}
      <TransientNotice
        message={notice?.owner === owner ? notice.message : null}
        tone={notice?.tone}
        onClear={clearNotice}
        visible={active}
      />
    </>
  )
}

function ThreadPersonalTaskPanel({
  intent,
  active,
  services,
  localProjects,
  runtimeWork,
  onOpenRuntimeTask,
  notify,
  clearNotice,
  onClosed,
}: RuntimeProps & {
  intent: PersonalTaskIntent
  active: boolean
  notify(message: string, tone?: 'success' | 'error'): void
  clearNotice(): void
  onClosed(): void
}) {
  const { t } = useTranslation('common')
  const { t: collaboration } = useTranslation('collaboration')
  const context = intent.context
  const actor = context.participation!.current_user_id
  const project = useRef(context.project)
  const state = useIssuePersonalTaskState()
  const runtimePort = useMemo(
    () => issueRuntimeBindingPort(services, context.project.project_store),
    [services, context.project.project_store]
  )
  const requireStart = useCallback(
    () =>
      requireThreadHumanTaskStart({
        context,
        dispatch: intent.dispatch,
        groups: services.chatGroupApis?.[context.sourceStore],
        chat: services.projectSpaceDetailServices?.[context.sourceStore]?.projectChatClient,
        unavailable: collaboration('executionContextUnavailable'),
        isCurrent: () => active && state.active.current,
      }),
    [
      context,
      intent.dispatch,
      services.chatGroupApis,
      services.projectSpaceDetailServices,
      active,
      state.active,
      collaboration,
    ]
  )
  const beforeStart = useCallback(async () => {
    await requireStart()
  }, [requireStart])
  const onOpenIssue = useCallback(() => {}, [])
  const onChanged = useCallback(() => {}, [])
  const controller = useIssuePersonalTaskConversation({
    state,
    project: context.project,
    latestProjectRef: project,
    api: context.api,
    detailServices: services.projectSpaceDetailServices?.[context.sourceStore],
    userId: actor,
    taskOwnerUserId: context.sourceStore === 'local' ? 0 : actor,
    services,
    runtimePort,
    runtimeWork,
    localProjects,
    onOpenRuntimeTask,
    onOpenIssue,
    locationIssueId: context.item.id,
    notify,
    clearNotice,
    onChanged,
    beforeStart,
    purpose: intent.dispatch ? 'assigned_work' : 'personal_assistance',
    embedded: false,
    open: active,
    onClosed,
  })
  const start = useStableEvent(async (isCurrent: () => boolean) => {
    if (state.taskComposer) return
    try {
      if (intent.binding) {
        await controller.openBoundTaskConversation(
          context.item,
          issueExecutionAddress(
            intent.binding,
            runtimeWork,
            context.group.id,
            context.item.id,
            context.project.project_store
          )
        )
      } else {
        const item = await requireStart()
        if (!isCurrent()) return
        if (intent.dispatch) await controller.answerIssueDispatch(intent.dispatch)
        else await controller.openNewTaskConversation(item)
      }
    } catch (error) {
      if (isCurrent())
        notify(error instanceof Error ? error.message : t('todo.linked_task_unavailable'), 'error')
    }
  })
  useEffect(() => {
    let current = true
    void start(() => current)
    return () => {
      current = false
    }
  }, [start])
  return controller.conversationPanel
}
