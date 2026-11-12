import { useGroupThreadActions } from './threadActionsContext'
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { CloudLoopItem } from '@/api/deliveries'
import { TransientNotice } from '@/components/common/TransientNotice'
import type { ChatGroup, ChatGroupMember } from '@/api/chatGroups'
import { ApiError } from '@/api/http'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { openWeworkScheme } from '@/features/notifications/schemeEvents'
import { weworkThreadScheme } from '@/features/notifications/scheme'
import { createLocalWorkspaceApi } from '@/features/todo/localWorkspaceApi'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkItemContextPanelProps } from '@/features/todo/WorkItemContextPanel'
import { GroupConversation } from './GroupConversation'
import { createGroupWorkspaceApi, groupBoardContext } from './groupWorkspaceApi'
import { GroupThreadPersonalTaskController } from './GroupThreadPersonalTaskController'
import { threadWorkOwner } from './threadPersonalTaskAccess'

interface ThreadContextData {
  group: ChatGroup
  members: ChatGroupMember[]
  item: CollaborationIssue
  items: CollaborationIssue[]
}

/** The same group-owned discussion inside pending work and private task context. */
export function GroupThreadContextPanel(props: WorkItemContextPanelProps) {
  const { t, i18n } = useTranslation('collaboration')
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en'
  const connection = useContext(CloudConnectionContext)
  const store = props.project.project_store === 'local' ? 'local' : 'cloud'
  const groups = props.services.chatGroupApis?.[store]
  const actor =
    store === 'local'
      ? (props.services.localParticipationIdentity?.currentUser.id ?? props.currentUserId)
      : props.currentUserId
  const accountScope = JSON.stringify([connection?.apiBaseUrl ?? '', props.currentUserId])
  const groupId = props.item.group_id
  const base = useMemo(
    () =>
      store === 'local'
        ? actor === undefined
          ? null
          : createLocalWorkspaceApi(
              props.api,
              Number(actor),
              String(actor),
              null,
              props.services.projectSpaceDetailServices?.local,
              locale
            )
        : props.services.sharedWorkspaceApi,
    [
      store,
      actor,
      props.api,
      props.services.projectSpaceDetailServices?.local,
      props.services.sharedWorkspaceApi,
      locale,
    ]
  )
  const scope = useMemo(
    () => ({ base, groups, accountScope, groupId, itemId: props.item.id, store }),
    [base, groups, accountScope, groupId, props.item.id, store]
  )
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const [result, setResult] = useState<{
    scope: object
    data?: ThreadContextData
    error?: string
  } | null>(null)
  const active = props.active ?? true
  const validOwner = Boolean(
    groupId &&
    String(props.item.cloud_project_id) === groupId &&
    String(props.project.id) === groupId
  )
  useEffect(() => {
    if (!active || !validOwner || !base || !groups || !groupId) return
    let current = true
    let authorized = false
    void groups
      .get(groupId)
      .then(async record => {
        if (!current) return null
        if (record.group.id !== groupId) throw new ApiError(t('threadLinkUnavailable'), 404)
        authorized = true
        const [item, items] = await Promise.all([
          base.issues.get(props.item.id),
          base.issues.list(groupId),
        ])
        return { record, item, items }
      })
      .then(value => {
        if (!current || !value) return
        const { record, item, items } = value
        if (
          record.group.id !== groupId ||
          item.id !== props.item.id ||
          item.group_id !== groupId ||
          String(item.cloud_project_id) !== groupId
        )
          throw new ApiError(t('threadLinkUnavailable'), 404)
        if (current)
          setResult({
            scope,
            data: {
              ...record,
              item,
              items: items.filter(
                candidate =>
                  candidate.group_id === groupId && String(candidate.cloud_project_id) === groupId
              ),
            },
          })
      })
      .catch(error => {
        if (!current) return
        const denied = error instanceof ApiError && [401, 403, 404].includes(error.status)
        setResult(previous => ({
          scope,
          error: error instanceof Error ? error.message : t('loadFailed'),
          data: authorized && !denied && previous?.scope === scope ? previous.data : undefined,
        }))
      })
    return () => {
      current = false
    }
  }, [
    active,
    validOwner,
    base,
    groups,
    groupId,
    props.item.id,
    props.item.version,
    revision,
    scope,
    t,
  ])
  const current = result?.scope === scope ? result : null
  const unavailable = !validOwner || !base || !groups
  const data = current?.data
  const api = useMemo(
    () =>
      base && groups && groupId
        ? createGroupWorkspaceApi(base, groups, groupId, store, refresh)
        : null,
    [base, groups, groupId, store, refresh]
  )
  if (unavailable || (current?.error && !data))
    return (
      <div className="space-y-3 p-5">
        <p role="alert" className="text-sm text-error">
          {current?.error ?? t('threadLinkUnavailable')}
        </p>
        {!unavailable && (
          <button
            type="button"
            data-testid="thread-context-retry"
            className="rounded px-3 py-1.5 text-sm hover:bg-hover"
            onClick={refresh}
          >
            {t('retry')}
          </button>
        )}
      </div>
    )
  if (!data || !api || !groups)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('loading')}
      </p>
    )
  return (
    <section data-testid="work-item-context-panel" className="flex min-h-0 flex-1 flex-col">
      {current?.error && (
        <div role="alert" className="flex items-center gap-2 px-5 py-2 text-sm text-text-muted">
          <span>{t('loadFailed')}</span>
          <button type="button" data-testid="thread-context-refresh-retry" onClick={refresh}>
            {t('retry')}
          </button>
        </div>
      )}
      <GroupThreadPersonalTaskController
        owner={threadWorkOwner(accountScope, store, groupId!, data.item.id)}
        active={active}
        locale={locale}
        services={props.services}
        runtimeWork={props.runtimeWork}
        runtimeTaskLifecycle={props.runtimeTaskLifecycle}
        localProjects={props.localProjects ?? []}
        deviceNamesById={props.deviceNamesById}
        onOpenRuntimeTask={props.onOpenRuntimeTask ?? props.onOpenTask}
      >
        <EmbeddedThreadRoom
          data={data}
          api={api}
          base={base!}
          groups={groups}
          store={store}
          accountScope={accountScope}
          locale={locale}
          refresh={refresh}
          props={props}
        />
      </GroupThreadPersonalTaskController>
    </section>
  )
}

function EmbeddedThreadRoom({
  data,
  api,
  base,
  groups,
  store,
  accountScope,
  locale,
  refresh,
  props,
}: {
  data: ThreadContextData
  api: SharedWorkspaceApi
  base: SharedWorkspaceApi
  groups: NonNullable<NonNullable<WorkItemContextPanelProps['services']['chatGroupApis']>['local']>
  store: 'local' | 'cloud'
  accountScope: string
  locale: 'zh-CN' | 'en'
  refresh(): void
  props: WorkItemContextPanelProps
}) {
  const { t } = useTranslation('collaboration')
  const actions = useGroupThreadActions()
  const navigationScope = useMemo(
    () => ({
      api: props.api,
      owner: threadWorkOwner(accountScope, store, data.group.id, data.item.id),
    }),
    [props.api, accountScope, store, data.group.id, data.item.id]
  )
  const currentNavigation = useRef<object | null>(navigationScope)
  useLayoutEffect(() => {
    currentNavigation.current = navigationScope
    return () => {
      currentNavigation.current = null
    }
  }, [navigationScope])
  const [navigationError, setNavigationError] = useState<{ scope: object; message: string } | null>(
    null
  )
  const clearNavigationError = useCallback(() => setNavigationError(null), [])

  const leaveGuard = useRef<((action: () => void) => void) | null>(null)
  const registerLeaveGuard = useCallback((guard: ((action: () => void) => void) | null) => {
    leaveGuard.current = guard
  }, [])
  const requestLeave = useCallback((action: () => void) => {
    if (leaveGuard.current) leaveGuard.current(action)
    else action()
  }, [])
  const [clearFocus, setClearFocus] = useState<string | null>(null)
  const focusKey = `${props.focusedCommentRequestKey ?? ''}:${props.focusedCommentId ?? ''}`
  const clear = useCallback(() => setClearFocus(focusKey), [focusKey])
  return (
    <>
      <TransientNotice
        message={navigationError?.scope === navigationScope ? navigationError.message : null}
        tone="error"
        onClear={clearNavigationError}
        visible={props.active ?? true}
      />
      <GroupConversation
        key={`${accountScope}:${store}:${data.group.id}:${data.item.id}`}
        active={props.active ?? true}
        {...actions}
        group={data.group}
        project={groupBoardContext(data.group, store)}
        item={data.item}
        items={data.items}
        api={api}
        catalog={base}
        changeRequestApi={props.services.deviceApi}
        members={data.members}
        groups={groups}
        chat={
          store === 'local'
            ? props.services.localProjectChatClient
            : props.services.projectChatClient
        }
        locale={locale}
        accountScope={accountScope}
        requestLeave={requestLeave}
        registerLeaveGuard={registerLeaveGuard}
        onChanged={refresh}
        focusedCommentId={clearFocus === focusKey ? null : props.focusedCommentId}
        focusRequestKey={props.focusedCommentRequestKey}
        onClearFocus={clear}
        onBack={() =>
          requestLeave(() =>
            openWeworkScheme(
              `wework://groups/${store === 'local' ? 'local' : 'backend'}/${encodeURIComponent(data.group.id)}`
            )
          )
        }
        onOpenThread={id =>
          requestLeave(() => {
            if (!props.onOpenChildTask) {
              openWeworkScheme(
                weworkThreadScheme(data.group.id, id, store === 'local' ? 'local' : 'backend')
              )
              return
            }
            void props.api
              .getLoopItem(id)
              .then((item: CloudLoopItem) => {
                if (currentNavigation.current !== navigationScope) return
                if (
                  item.id !== id ||
                  item.group_id !== data.group.id ||
                  String(item.cloud_project_id) !== data.group.id
                )
                  throw new ApiError(t('threadLinkUnavailable'), 404)
                props.onOpenChildTask?.(item)
              })
              .catch(error => {
                if (currentNavigation.current === navigationScope)
                  setNavigationError({
                    scope: navigationScope,
                    message: error instanceof Error ? error.message : String(error),
                  })
              })
          })
        }
      />
    </>
  )
}
