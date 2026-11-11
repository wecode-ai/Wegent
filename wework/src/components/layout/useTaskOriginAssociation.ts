import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatGroupApi } from '@/api/chatGroups'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import {
  isDefaultWorkItemProject,
  type ProjectSpaceApi,
} from '@/features/todo/projectSpaceSelection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { projectTaskRuntimeApiForProject } from '@/features/workbench/projectTaskTracking'
import { truncateRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  runtimeTaskAddressForBinding,
  type BoundProjectSpaceContextUpdate,
} from './workbenchTaskOriginState'
import { replaceTaskOrigin, TaskOriginRecoveryError } from './replaceTaskOrigin'

type Source = {
  api: ProjectSpaceApi | undefined
  groups: ChatGroupApi | undefined
  runtime: unknown
}
interface Association {
  owner: object
  source: Source
  project: CloudProject
  items: CloudLoopItem[]
  loading: boolean
  pending: boolean
}
interface JoinRequest {
  owner: object
  source: Source
  project: CloudProject
  item: CloudLoopItem
  pending: boolean
  error: string | null
}

function sourceFor(
  services: WorkbenchServices | undefined,
  apiFor: (project: CloudProject) => ProjectSpaceApi | undefined,
  project: CloudProject
): Source {
  const native =
    project.resource_type === 'chat_group' || ['local', 'backend'].includes(project.task_provider)
  return {
    api: apiFor(project),
    groups: native
      ? services?.chatGroupApis?.[project.project_store === 'local' ? 'local' : 'cloud']
      : undefined,
    runtime: projectTaskRuntimeApiForProject(services, project),
  }
}
function sameSource(left: Source, right: Source) {
  return left.api === right.api && left.groups === right.groups && left.runtime === right.runtime
}

export function useTaskOriginAssociation({
  accountScope,
  paneKey,
  contextRuntimeTask,
  boundProject,
  boundItem,
  currentRuntimeTaskRef,
  services,
  runtimeTaskTitle,
  runtimeTaskDescription,
  projectSpaceApiFor,
  setPendingCloudContext,
  setDismissedDefaultCloudProjectKey,
  setTodoBindingError,
  setCloudActionNotice,
  onBound,
  onLinkRecoveryFailed,
}: {
  accountScope: string
  paneKey: string
  contextRuntimeTask: RuntimeTaskAddress | null
  boundProject?: CloudProject | null
  boundItem?: CloudLoopItem | null
  currentRuntimeTaskRef: RefObject<RuntimeTaskAddress | null>
  services: WorkbenchServices | undefined
  runtimeTaskTitle: string | null
  runtimeTaskDescription: string
  projectSpaceApiFor(project: CloudProject): ProjectSpaceApi | undefined
  setPendingCloudContext(project: CloudProject | null, item: CloudLoopItem | null): void
  setDismissedDefaultCloudProjectKey(key: string | null): void
  setTodoBindingError(message: string | null): void
  setCloudActionNotice(message: string | null): void
  onBound(update: BoundProjectSpaceContextUpdate): void
  onLinkRecoveryFailed?(): void
}) {
  const { t } = useTranslation('common')
  const deviceId = contextRuntimeTask?.deviceId
  const taskId = contextRuntimeTask?.taskId
  const owner = useMemo(
    () => ({ accountScope, paneKey, deviceId, taskId }),
    [accountScope, paneKey, deviceId, taskId]
  )
  const scopeKey = JSON.stringify([
    accountScope,
    paneKey,
    contextRuntimeTask?.deviceId,
    contextRuntimeTask?.taskId,
  ])
  const live = useRef<{
    owner: object
    services: typeof services
    apiFor: typeof projectSpaceApiFor
  } | null>({ owner, services, apiFor: projectSpaceApiFor })
  useLayoutEffect(() => {
    live.current = { owner, services, apiFor: projectSpaceApiFor }
    return () => {
      live.current = null
    }
  }, [owner, services, projectSpaceApiFor])
  const current = useCallback((requestOwner: object, project: CloudProject, source: Source) => {
    const value = live.current
    return Boolean(
      value &&
      value.owner === requestOwner &&
      sameSource(source, sourceFor(value.services, value.apiFor, project))
    )
  }, [])
  const [association, setAssociation] = useState<Association | null>(null)
  const taskBoardAssociation =
    association &&
    association.owner === owner &&
    sameSource(association.source, sourceFor(services, projectSpaceApiFor, association.project))
      ? association
      : null
  const [creation, setCreation] = useState<{ owner: object; target?: CloudProject } | null>(null)
  const taskOriginCreation = creation?.owner === owner ? creation : null
  const [joinRequest, setJoinRequest] = useState<JoinRequest | null>(null)
  const taskOriginJoinRequest =
    joinRequest &&
    joinRequest.owner === owner &&
    sameSource(joinRequest.source, sourceFor(services, projectSpaceApiFor, joinRequest.project))
      ? joinRequest
      : null

  const handleSelectCloudProject = useCallback(
    (project: CloudProject) => {
      setDismissedDefaultCloudProjectKey(null)
      if (isDefaultWorkItemProject(project)) {
        if (!contextRuntimeTask) setPendingCloudContext(project, null)
        return
      }
      const source = sourceFor(services, projectSpaceApiFor, project)
      if (!source.api) return
      const request: Association = {
        owner,
        source,
        project,
        items: [],
        loading: true,
        pending: false,
      }
      setAssociation(request)
      void source.api
        .listLoopItems(project.id)
        .then(response => {
          if (current(owner, project, source))
            setAssociation(previous =>
              previous?.owner === owner && previous.project === project
                ? { ...previous, items: response.items, loading: false }
                : previous
            )
        })
        .catch(cause => {
          if (!current(owner, project, source)) return
          setAssociation(previous =>
            previous?.owner === owner && previous.project === project
              ? { ...previous, loading: false, items: [] }
              : previous
          )
          setTodoBindingError(
            cause instanceof Error
              ? cause.message
              : t('workbench.task_board_items_load_failed', '加载看板任务失败')
          )
        })
    },
    [
      contextRuntimeTask,
      owner,
      services,
      projectSpaceApiFor,
      current,
      setPendingCloudContext,
      setDismissedDefaultCloudProjectKey,
      setTodoBindingError,
      t,
    ]
  )

  const closeTaskBoardAssociation = useCallback(
    () => setAssociation(previous => (previous?.pending ? previous : null)),
    []
  )
  const openTaskOriginCreation = useCallback(() => {
    setAssociation(null)
    setCreation({ owner })
  }, [owner])
  const closeTaskOriginCreation = useCallback(() => setCreation(null), [])

  const associateRuntimeTask = useCallback(
    async (item: CloudLoopItem | null, explicitOwner?: CloudProject, created = false) => {
      const selected = taskBoardAssociation
      const project = explicitOwner ?? selected?.project
      if (!project) return
      const source = sourceFor(services, projectSpaceApiFor, project)
      if (!current(owner, project, source)) return
      setAssociation(previous =>
        previous?.owner === owner ? { ...previous, pending: true } : previous
      )
      setTodoBindingError(null)
      let workOwner = project
      try {
        if (
          created &&
          (project.resource_type !== 'chat_group' ||
            !item?.group_id ||
            item.group_id !== project.id)
        )
          throw new Error(t('collaboration:threadLinkUnavailable'))
        const groupId =
          item?.group_id ?? (project.resource_type === 'chat_group' ? project.id : null)
        if (groupId) {
          if (!source.groups || !item || item.cloud_project_id !== groupId)
            throw new Error(t('collaboration:threadLinkUnavailable'))
          const [info, participation] = await Promise.all([
            source.groups.get(groupId),
            source.groups.participation(item.id),
          ])
          if (!current(owner, project, source)) return
          if (
            info.group.id !== groupId ||
            info.group.status !== 'active' ||
            !['Owner', 'Maintainer', 'Developer'].includes(info.group.role)
          )
            throw new Error(t('collaboration:readOnly'))
          workOwner = groupWorkContainer(
            info.group,
            project.project_store === 'local' ? 'local' : 'cloud'
          )
          if (!participation.joined) {
            if (created) throw new Error(t('collaboration:readOnly'))
            setJoinRequest({
              owner,
              source: sourceFor(services, projectSpaceApiFor, workOwner),
              project: workOwner,
              item,
              pending: false,
              error: null,
            })
            setAssociation(previous =>
              previous?.owner === owner ? { ...previous, pending: false } : previous
            )
            return
          }
          if (!participation.can_comment || participation.current_user_id == null)
            throw new Error(t('collaboration:readOnly'))
        }
        if (!contextRuntimeTask) {
          setPendingCloudContext(workOwner, item)
          setAssociation(null)
          setCreation(null)
          setCloudActionNotice(
            item
              ? t('workbench.task_board_association_pending_existing', { title: item.title })
              : t('workbench.task_board_association_pending_new', { name: workOwner.name })
          )
          return
        }
        const api = projectTaskRuntimeApiForProject(services, workOwner)
        if (!api) throw new Error(t('workbench.cloud_project_bind_failed', '关联项目空间失败'))
        const title =
          runtimeTaskTitle ||
          truncateRuntimeTaskTitle(runtimeTaskDescription) ||
          t('workbench.untitled_task', '未命名任务')
        const task = runtimeTaskAddressForBinding(contextRuntimeTask, currentRuntimeTaskRef.current)
        const previous =
          boundProject && boundItem && !isDefaultWorkItemProject(boundProject)
            ? {
                api: projectTaskRuntimeApiForProject(services, boundProject),
                source: sourceFor(services, projectSpaceApiFor, boundProject),
                item: boundItem,
              }
            : null
        if (previous && !previous.api) throw new Error(t('collaboration:threadLinkUnavailable'))
        const linked = await replaceTaskOrigin({
          previous: previous?.api ? { api: previous.api, item: previous.item } : null,
          target: api,
          task,
          title,
          recoveryFailed: t('collaboration:taskLinkRecoveryFailed'),
          current: () =>
            current(owner, project, source) &&
            (!previous || current(owner, boundProject!, previous.source)),
          link: async () => {
            if (item) {
              await api.bindTask(item.id, task, title)
              return item
            }
            return (await api.trackProjectTask(workOwner.id, task, title, runtimeTaskDescription))
              .item
          },
        })
        if (!linked) return
        setAssociation(previous => (previous?.owner === owner ? null : previous))
        setCreation(previous => (previous?.owner === owner ? null : previous))
        if (!current(owner, project, source)) return
        onBound({ task: contextRuntimeTask, project: workOwner, item: linked })
        setCloudActionNotice(
          t('workbench.task_board_association_success', { name: workOwner.name })
        )
      } catch (cause) {
        if (current(owner, project, source)) {
          if (cause instanceof TaskOriginRecoveryError) onLinkRecoveryFailed?.()
          setAssociation(previous =>
            previous?.owner === owner ? { ...previous, pending: false } : previous
          )
          setTodoBindingError(
            cause instanceof Error
              ? cause.message
              : t('workbench.cloud_project_bind_failed', '关联项目空间失败')
          )
        }
        if (created) throw cause
      } finally {
        setAssociation(previous =>
          previous?.owner === owner && previous.pending ? { ...previous, pending: false } : previous
        )
      }
    },
    [
      taskBoardAssociation,
      services,
      projectSpaceApiFor,
      current,
      owner,
      t,
      contextRuntimeTask,
      boundProject,
      boundItem,
      currentRuntimeTaskRef,
      runtimeTaskTitle,
      runtimeTaskDescription,
      setPendingCloudContext,
      setTodoBindingError,
      setCloudActionNotice,
      onBound,
      onLinkRecoveryFailed,
    ]
  )

  const associateRuntimeTaskWithNewItem = useCallback(() => {
    const project = taskBoardAssociation?.project
    if (!project) return
    if (
      project.resource_type === 'chat_group' ||
      ['local', 'backend'].includes(project.task_provider)
    ) {
      setCreation({ owner, target: project })
      return
    }
    void associateRuntimeTask(null)
  }, [associateRuntimeTask, owner, taskBoardAssociation])
  const associateRuntimeTaskWithExistingItem = useCallback(
    (item: CloudLoopItem) => void associateRuntimeTask(item),
    [associateRuntimeTask]
  )
  const associateCreatedTaskOrigin = useCallback(
    (item: CloudLoopItem, project: CloudProject) => associateRuntimeTask(item, project, true),
    [associateRuntimeTask]
  )
  const cancelTaskOriginJoin = useCallback(
    () => setJoinRequest(previous => (previous?.pending ? previous : null)),
    []
  )
  const confirmTaskOriginJoin = useCallback(async () => {
    const request = taskOriginJoinRequest
    if (!request || request.pending || !request.source.groups) return
    setJoinRequest(previous =>
      previous === request ? { ...previous, pending: true, error: null } : previous
    )
    try {
      const result = await request.source.groups.setParticipation(request.item.id, { joined: true })
      if (!current(request.owner, request.project, request.source)) return
      if (!result.joined || !result.can_comment || result.current_user_id == null)
        throw new Error(t('collaboration:readOnly'))
      await associateRuntimeTask(request.item, request.project, true)
      if (current(request.owner, request.project, request.source)) setJoinRequest(null)
    } catch (cause) {
      if (current(request.owner, request.project, request.source))
        setJoinRequest(previous =>
          previous?.owner === request.owner && previous.item.id === request.item.id
            ? {
                ...previous,
                pending: false,
                error: cause instanceof Error ? cause.message : t('collaboration:loadFailed'),
              }
            : previous
        )
    } finally {
      setJoinRequest(previous =>
        previous?.owner === request.owner &&
        previous.item.id === request.item.id &&
        previous.pending
          ? { ...previous, pending: false }
          : previous
      )
    }
  }, [taskOriginJoinRequest, current, associateRuntimeTask, t])

  return {
    taskBoardAssociation,
    handleSelectCloudProject,
    closeTaskBoardAssociation,
    associateRuntimeTaskWithNewItem,
    associateRuntimeTaskWithExistingItem,
    taskOriginCreation,
    openTaskOriginCreation,
    closeTaskOriginCreation,
    associateCreatedTaskOrigin,
    taskOriginJoinRequest,
    cancelTaskOriginJoin,
    confirmTaskOriginJoin,
    scopeKey,
  }
}
