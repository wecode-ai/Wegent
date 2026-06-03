import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'
import { createDeviceApi } from '@/api/devices'
import { commitProjectChanges, loadProjectEnvironment } from '@/api/environment'
import { createHttpClient } from '@/api/http'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import { createChatStream } from '@/stream/chatStream'
import { createSocketClient } from '@/stream/socketClient'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import type {
  Attachment,
  ArchivedTaskListResponse,
  ChatSendPayload,
  CreateProjectRequest,
  DeviceInfo,
  ModelOptions,
  ModelSelectionConfig,
  ProjectWithTasks,
  SkillRef,
  Subtask,
  Task,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { ToolBlock, WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import { messageReducer, normalizeBlockStatus } from './messageReducer'
import {
  initialWorkbenchState,
  workbenchReducer,
} from './workbenchReducer'
import { WorkbenchContext } from './useWorkbench'

const WEWORK_CLIENT_ORIGIN = 'wework'

export interface WorkbenchServices {
  teamApi: ReturnType<typeof createTeamApi>
  modelApi: ReturnType<typeof createModelApi>
  skillApi: ReturnType<typeof createSkillApi>
  projectApi: ReturnType<typeof createProjectApi>
  taskApi: ReturnType<typeof createTaskApi>
  deviceApi: ReturnType<typeof createDeviceApi>
  userApi?: ReturnType<typeof createUserApi>
  chatStream: ReturnType<typeof createChatStream>
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  projectChat: {
    models: UnifiedModel[]
    skills: UnifiedSkill[]
    selectedModel: UnifiedModel | null
    selectedModelOptions: ModelOptions
    isModelSelectionReady: boolean
    selectedSkills: SkillRef[]
    attachments: Attachment[]
    uploadingFiles: Map<string, { file: File; progress: number }>
    errors: Map<string, string>
    isOptionsLocked: boolean
    isAttachmentReadyToSend: boolean
    setSelectedModel: (model: UnifiedModel | null) => void
    setSelectedModelOption: (optionId: string, value: string) => void
    setSelectedSkills: (skills: SkillRef[]) => void
    toggleSkill: (skill: SkillRef) => void
    handleFileSelect: (files: File | File[]) => Promise<void>
    addExistingAttachment: (attachment: Attachment) => void
    removeAttachment: (attachmentId: number) => Promise<void>
    resetAttachments: () => void
  }
  runningTaskIds: Set<number>
  selectProject: (projectId: number | null) => void
  selectStandaloneDevice: (deviceId: string | null) => void
  startNewChat: () => void
  startStandaloneChat: () => void
  startNewProjectChat: (projectId: number) => void
  openTask: (taskId: number, projectId?: number) => Promise<void>
  rememberExecutionDevice: (deviceId: string) => void
  refreshWorkLists: () => Promise<void>
  refreshDevices: () => Promise<void>
  createProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  updateProjectName: (projectId: number, name: string) => Promise<void>
  removeProject: (projectId: number) => Promise<void>
  archiveAllChats: () => Promise<void>
  archiveAllProjectChats: () => Promise<void>
  archiveProjectChats: (projectId: number) => Promise<void>
  archiveTask: (taskId: number) => Promise<void>
  renameTask: (taskId: number, title: string) => Promise<void>
  listArchivedTasks: () => Promise<ArchivedTaskListResponse>
  unarchiveTask: (taskId: number) => Promise<void>
  deleteTask: (taskId: number) => Promise<void>
  deleteArchivedTasks: () => Promise<void>
  getDeviceHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  loadEnvironmentInfo: (project: ProjectWithTasks | null) => Promise<EnvironmentInfo>
  commitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
  ) => Promise<void>
  setInput: (input: string) => void
  sendCurrentInput: () => Promise<void>
}

interface WorkbenchProviderProps {
  children: ReactNode
  user: User
  services?: WorkbenchServices
}

function createDefaultServices(): WorkbenchServices {
  const { apiBaseUrl } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
  const socket = createSocketClient()

  return {
    teamApi: createTeamApi(client),
    modelApi: createModelApi(client),
    skillApi: createSkillApi(client),
    projectApi: createProjectApi(client),
    taskApi: createTaskApi(client),
    deviceApi: createDeviceApi(client),
    userApi: createUserApi(client),
    chatStream: createChatStream(socket),
  }
}

interface SubtaskResult {
  value?: string
  blocks?: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getSubtaskResult(result: unknown): SubtaskResult | undefined {
  if (!isRecord(result)) return undefined
  return {
    value: typeof result.value === 'string' ? result.value : undefined,
    blocks: Array.isArray(result.blocks) ? result.blocks : undefined,
  }
}

function getPersistedToolBlocks(subtask: Subtask, blocks?: unknown[]): ToolBlock[] {
  if (!blocks) return []

  return blocks.flatMap((block, index) => {
    if (!isRecord(block) || block.type !== 'tool') return []

    const id =
      typeof block.id === 'string'
        ? block.id
        : typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : `tool-${subtask.id}-${index}`
    const timestamp = typeof block.timestamp === 'number' ? block.timestamp : Date.now()

    return [
      {
        id,
        subtaskId: subtask.id,
        toolName: typeof block.tool_name === 'string' ? block.tool_name : 'unknown',
        toolInput: isRecord(block.tool_input) ? block.tool_input : undefined,
        toolOutput: block.tool_output,
        status: normalizeBlockStatus(
          typeof block.status === 'string' ? block.status : undefined
        ),
        createdAt: timestamp,
      },
    ]
  })
}

function subtaskToMessage(subtask: Subtask): WorkbenchMessage {
  const result = getSubtaskResult(subtask.result)
  const role = subtask.role.toLowerCase() === 'user' ? 'user' : 'assistant'
  const blocks = getPersistedToolBlocks(subtask, result?.blocks)
  return {
    id: `subtask-${subtask.id}`,
    taskId: subtask.task_id,
    subtaskId: subtask.id,
    role,
    content: subtask.prompt || result?.value || '',
    status: subtask.status === 'FAILED' ? 'failed' : 'done',
    blocks: blocks.length > 0 ? blocks : undefined,
    createdAt: subtask.created_at,
  }
}

function sortSubtasksForDisplay(subtasks: Subtask[]): Subtask[] {
  return [...subtasks].sort((left, right) => {
    const leftMessageId = left.message_id ?? Number.MAX_SAFE_INTEGER
    const rightMessageId = right.message_id ?? Number.MAX_SAFE_INTEGER
    if (leftMessageId !== rightMessageId) {
      return leftMessageId - rightMessageId
    }

    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  })
}

function getLastProjectStorageKey(userId: number) {
  return `wework.lastProjectId.${userId}`
}

function readLastProjectId(userId: number): number | null {
  try {
    const value = window.localStorage.getItem(getLastProjectStorageKey(userId))
    if (!value) return null
    const id = Number(value)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

function writeLastProjectId(userId: number, projectId: number) {
  try {
    window.localStorage.setItem(getLastProjectStorageKey(userId), String(projectId))
  } catch {
    // Ignore storage failures; project selection still works for the current session.
  }
}

function getTaskModelSelection(task: Task | null): ModelSelectionConfig | null {
  if (!task?.model_id) return null
  return {
    modelName: task.model_id,
    modelType: task.force_override_bot_model_type ?? null,
    options: task.model_options ?? {},
  }
}

function getNewChatModelSelection(user: User | null): ModelSelectionConfig | null {
  return user?.preferences?.wework_new_chat_model_selection ?? null
}

function isRunningTaskStatus(status?: string) {
  return ['PENDING', 'RUNNING', 'STARTED', 'PROCESSING', 'IN_PROGRESS'].includes(
    String(status ?? '').toUpperCase()
  )
}

function resolveOpenedTaskProjectId(
  task: Task,
  listTask: Task | undefined,
  explicitProjectId?: number
): number | undefined {
  if (explicitProjectId !== undefined) return explicitProjectId
  if (task.project_id !== undefined) return task.project_id
  if (listTask && !listTask.project_id) return 0
  return undefined
}

function getRememberedStandaloneDeviceId(
  user: User,
  devices: DeviceInfo[],
  fallbackDeviceId?: string | null
) {
  return getPreferredStandaloneDeviceId(
    devices,
    user.preferences?.default_execution_target ?? fallbackDeviceId
  )
}

export function WorkbenchProvider({
  children,
  user,
  services,
}: WorkbenchProviderProps) {
  const resolvedServices = useMemo(
    () => services ?? createDefaultServices(),
    [services]
  )
  const [state, dispatch] = useReducer(
    workbenchReducer,
    initialWorkbenchState
  )
  const [messages, dispatchMessages] = useReducer(messageReducer, [])
  const isOptionsLocked = Boolean(state.currentTask)
  const currentUser = state.user ?? user
  const modelSelectionConfig = useMemo(
    () =>
      getTaskModelSelection(state.currentTask) ??
      getNewChatModelSelection(currentUser) ??
      null,
    [currentUser, state.currentTask]
  )
  const modelCompatibilityConfig = useMemo(
    () => getTaskModelSelection(state.currentTask),
    [state.currentTask]
  )
  const persistNewChatModelSelection = useCallback(
    (selection: ModelSelectionConfig) => {
      const preferences = {
        ...(currentUser.preferences ?? {}),
        wework_new_chat_model_selection: selection,
      }
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi
        ?.updateCurrentUser({ preferences })
        .catch(() => {
          dispatch({ type: 'error_set', error: '模型配置保存失败' })
        })
    },
    [currentUser.preferences, resolvedServices.userApi]
  )
  const handleModelSelectionChange = useCallback(
    (selection: ModelSelectionConfig) => {
      if (state.currentTask) {
        dispatch({
          type: 'current_task_model_selection_changed',
          selection,
        })
        return
      }
      persistNewChatModelSelection(selection)
    },
    [persistNewChatModelSelection, state.currentTask]
  )
  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: false,
    selectionConfig: modelSelectionConfig,
    compatibilityConfig: modelCompatibilityConfig,
    selectionReady: !state.isBootstrapping,
    onSelectionChange: handleModelSelectionChange,
  })
  const skillSelection = useWorkbenchSkills({
    api: resolvedServices.skillApi,
    teamId: state.defaultTeam?.id,
    locked: isOptionsLocked,
  })
  const attachmentSelection = useWorkbenchAttachments()

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      const [defaultTeamResult, projectsResult, recentTasksResult, devicesResult] = await Promise.allSettled([
        resolvedServices.teamApi.getDefaultWorkbenchTeam(),
        resolvedServices.projectApi.listProjects(),
        resolvedServices.taskApi.listRecentTasks({ limit: 20 }),
        resolvedServices.deviceApi.listDevices(),
      ])

      if (cancelled) return

      const projects =
        projectsResult.status === 'fulfilled' ? projectsResult.value.items : []
      const devices = devicesResult.status === 'fulfilled' ? devicesResult.value : []
      const lastProjectId = readLastProjectId(user.id)
      const currentProject =
        lastProjectId === null
          ? null
          : projects.find(project => project.id === lastProjectId) ?? null

      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects,
        devices,
        recentTasks:
          recentTasksResult.status === 'fulfilled' ? recentTasksResult.value.items : [],
        currentProject,
        standaloneDeviceId: getRememberedStandaloneDeviceId(user, devices),
      })
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [resolvedServices, user])

  const refreshWorkLists = useCallback(async () => {
    const [projectsResult, recentTasksResult, devicesResult] = await Promise.all([
      resolvedServices.projectApi.listProjects(),
      resolvedServices.taskApi.listRecentTasks({ limit: 20 }),
      resolvedServices.deviceApi.listDevices(),
    ])
    dispatch({
      type: 'lists_refreshed',
      projects: projectsResult.items,
      recentTasks: recentTasksResult.items,
      devices: devicesResult,
      standaloneDeviceId: getPreferredStandaloneDeviceId(
        devicesResult,
        state.standaloneDeviceId
      ),
    })
  }, [resolvedServices, state.standaloneDeviceId])

  const refreshDevices = useCallback(async () => {
    const devices = await resolvedServices.deviceApi.listDevices()
    dispatch({
      type: 'devices_refreshed',
      devices,
      standaloneDeviceId: getPreferredStandaloneDeviceId(
        devices,
        state.standaloneDeviceId
      ),
    })
  }, [resolvedServices, state.standaloneDeviceId])

  useEffect(() => {
    const handleDeviceChanged = () => {
      void refreshDevices()
    }

    return resolvedServices.chatStream.subscribe({
      onDeviceOnline: handleDeviceChanged,
      onDeviceOffline: handleDeviceChanged,
      onDeviceStatus: handleDeviceChanged,
      onChatStart: payload => {
        dispatch({
          type: 'task_status_changed',
          taskId: payload.task_id,
          status: 'RUNNING',
        })
        dispatchMessages({
          type: 'assistant_started',
          taskId: payload.task_id,
          subtaskId: payload.subtask_id,
        })
      },
      onChatChunk: payload =>
        dispatchMessages({
          type: 'assistant_chunk',
          subtaskId: payload.subtask_id,
          content: payload.content,
        }),
      onChatDone: payload => {
        if (payload.task_id) {
          dispatch({
            type: 'task_status_changed',
            taskId: payload.task_id,
            status: 'COMPLETED',
          })
        }
        dispatchMessages({
          type: 'assistant_done',
          subtaskId: payload.subtask_id,
          content:
            typeof payload.result.value === 'string'
              ? payload.result.value
              : undefined,
        })
      },
      onChatError: payload => {
        if (payload.task_id) {
          dispatch({
            type: 'task_status_changed',
            taskId: payload.task_id,
            status: 'FAILED',
          })
        }
        dispatchMessages({
          type: 'assistant_error',
          subtaskId: payload.subtask_id,
          error: payload.error,
        })
      },
      onBlockCreated: payload => {
        if (payload.block.type !== 'tool') return
        dispatchMessages({
          type: 'block_created',
          subtaskId: payload.subtask_id,
          block: {
            id: payload.block.id,
            subtaskId: payload.subtask_id,
            toolName: payload.block.tool_name ?? 'unknown',
            toolInput: payload.block.tool_input,
            toolOutput: payload.block.tool_output,
            status: normalizeBlockStatus(payload.block.status),
            createdAt: payload.block.timestamp ?? Date.now(),
          },
        })
      },
      onBlockUpdated: payload => {
        dispatchMessages({
          type: 'block_updated',
          subtaskId: payload.subtask_id,
          blockId: payload.block_id,
          updates: {
            ...(payload.tool_input && { toolInput: payload.tool_input }),
            ...(payload.tool_output !== undefined && { toolOutput: payload.tool_output }),
            ...(payload.status && { status: normalizeBlockStatus(payload.status) }),
          },
        })
      },
    })
  }, [refreshDevices, resolvedServices])

  const rememberExecutionDevice = useCallback(
    (deviceId: string) => {
      dispatch({
        type: 'standalone_device_preference_changed',
        standaloneDeviceId:
          getPreferredStandaloneDeviceId(state.devices, deviceId) ?? deviceId,
      })
      void resolvedServices.userApi
        ?.updateCurrentUser({
          preferences: {
            ...(user.preferences ?? {}),
            default_execution_target: deviceId,
          },
        })
        .catch(() => {
          // Keep the in-session selection even if preference persistence fails.
        })
    },
    [resolvedServices.userApi, state.devices, user.preferences]
  )

  const selectProject = useCallback(
    (projectId: number | null) => {
      if (projectId === null) {
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId: getRememberedStandaloneDeviceId(
            user,
            state.devices,
            state.standaloneDeviceId
          ),
        })
        dispatchMessages({ type: 'reset', messages: [] })
        return
      }
      const project = state.projects.find(item => item.id === projectId)
      if (project) {
        writeLastProjectId(user.id, project.id)
        dispatch({ type: 'project_selected', project })
        dispatchMessages({ type: 'reset', messages: [] })
      }
    },
    [state.devices, state.projects, state.standaloneDeviceId, user]
  )

  const selectStandaloneDevice = useCallback(
    (deviceId: string | null) => {
      const standaloneDeviceId = getPreferredStandaloneDeviceId(
        state.devices,
        deviceId ?? user.preferences?.default_execution_target ?? state.standaloneDeviceId
      )
      if (standaloneDeviceId) {
        rememberExecutionDevice(standaloneDeviceId)
      }
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
      })
      dispatchMessages({ type: 'reset', messages: [] })
    },
    [
      rememberExecutionDevice,
      state.devices,
      state.standaloneDeviceId,
      user.preferences?.default_execution_target,
    ]
  )

  const startNewChat = useCallback(() => {
    const lastProjectId = readLastProjectId(user.id)
    const project = lastProjectId
      ? state.projects.find(item => item.id === lastProjectId)
      : null
    if (project) {
      dispatch({ type: 'project_selected', project })
    } else {
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId: getRememberedStandaloneDeviceId(
          user,
          state.devices,
          state.standaloneDeviceId
        ),
      })
    }
    dispatchMessages({ type: 'reset', messages: [] })
  }, [state.devices, state.projects, state.standaloneDeviceId, user])

  const startStandaloneChat = useCallback(() => {
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
    })
    dispatchMessages({ type: 'reset', messages: [] })
  }, [state.devices, state.standaloneDeviceId, user])

  const startNewProjectChat = useCallback(
    (projectId: number) => {
      selectProject(projectId)
      dispatchMessages({ type: 'reset', messages: [] })
    },
    [selectProject]
  )

  const openTask = useCallback(
    async (taskId: number, projectId?: number) => {
      const detail = await resolvedServices.taskApi.getTaskDetail(taskId)
      const detailTask = detail as Task
      const listTask = state.recentTasks.find(item => item.id === taskId)
      const resolvedProjectId = resolveOpenedTaskProjectId(
        detailTask,
        listTask,
        projectId
      )
      const project =
        resolvedProjectId === undefined
          ? undefined
          : resolvedProjectId > 0
            ? state.projects.find(item => item.id === resolvedProjectId) ?? null
            : null
      if (project) {
        writeLastProjectId(user.id, project.id)
      }
      dispatch({
        type: 'task_opened',
        task: detail as Task,
        project,
        standaloneDeviceId:
          project === null
            ? getPreferredStandaloneDeviceId(
                state.devices,
                detailTask.device_id ?? listTask?.device_id ?? state.standaloneDeviceId
              )
            : undefined,
      })
      dispatchMessages({
        type: 'reset',
        messages: sortSubtasksForDisplay(detail.subtasks ?? []).map(subtaskToMessage),
      })
      await resolvedServices.chatStream.joinTask(taskId)
    },
    [
      resolvedServices,
      state.devices,
      state.projects,
      state.recentTasks,
      state.standaloneDeviceId,
      user.id,
    ]
  )

  const setInput = useCallback((input: string) => {
    dispatch({ type: 'input_changed', input })
  }, [])

  const createProject = useCallback(
    async (data: CreateProjectRequest) => {
      const project = await resolvedServices.projectApi.createProject(data)
      const projectDeviceId = data.config?.execution?.deviceId ?? data.config?.device_id
      if (projectDeviceId) {
        rememberExecutionDevice(projectDeviceId)
      }
      await refreshWorkLists()
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      dispatchMessages({ type: 'reset', messages: [] })
      return project
    },
    [refreshWorkLists, rememberExecutionDevice, resolvedServices, user.id]
  )

  const updateProjectName = useCallback(
    async (projectId: number, name: string) => {
      await resolvedServices.projectApi.updateProject(projectId, { name })
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const removeProject = useCallback(
    async (projectId: number) => {
      await resolvedServices.projectApi.deleteProject(projectId)
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const archiveAllChats = useCallback(async () => {
    await resolvedServices.taskApi.archiveAllChats()
    if (!state.currentProject && (!state.currentTask || !state.currentTask.project_id)) {
      dispatch({ type: 'current_task_cleared' })
      dispatchMessages({ type: 'reset', messages: [] })
    }
    await refreshWorkLists()
  }, [refreshWorkLists, resolvedServices, state.currentProject, state.currentTask])

  const archiveAllProjectChats = useCallback(async () => {
    await resolvedServices.projectApi.archiveAllProjectChats()
    if (state.currentProject || (state.currentTask?.project_id ?? 0) > 0) {
      dispatch({ type: 'current_task_cleared' })
      dispatchMessages({ type: 'reset', messages: [] })
    }
    await refreshWorkLists()
  }, [refreshWorkLists, resolvedServices, state.currentProject, state.currentTask?.project_id])

  const archiveProjectChats = useCallback(
    async (projectId: number) => {
      await resolvedServices.projectApi.archiveProjectChats(projectId)
      dispatch({ type: 'current_task_cleared' })
      dispatchMessages({ type: 'reset', messages: [] })
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const archiveTask = useCallback(
    async (taskId: number) => {
      await resolvedServices.taskApi.archiveTask(taskId)
      if (state.currentTask?.id === taskId) {
        dispatch({ type: 'current_task_cleared' })
        dispatchMessages({ type: 'reset', messages: [] })
      }
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices, state.currentTask?.id]
  )

  const renameTask = useCallback(
    async (taskId: number, title: string) => {
      await resolvedServices.taskApi.renameTask(taskId, title)
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const listArchivedTasks = useCallback(
    () => resolvedServices.taskApi.listArchivedTasks(),
    [resolvedServices]
  )

  const unarchiveTask = useCallback(
    async (taskId: number) => {
      await resolvedServices.taskApi.unarchiveTask(taskId)
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const deleteTask = useCallback(
    async (taskId: number) => {
      await resolvedServices.taskApi.deleteTask(taskId)
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const deleteArchivedTasks = useCallback(async () => {
    await resolvedServices.taskApi.deleteArchivedTasks()
    await refreshWorkLists()
  }, [refreshWorkLists, resolvedServices])

  const getDeviceHomeDirectory = useCallback(
    (deviceId: string) => resolvedServices.deviceApi.getHomeDirectory(deviceId),
    [resolvedServices]
  )

  const getProjectWorkspaceRoot = useCallback(
    (deviceId: string) => resolvedServices.deviceApi.getProjectWorkspaceRoot(deviceId),
    [resolvedServices]
  )

  const listDeviceDirectories = useCallback(
    (deviceId: string, path: string) =>
      resolvedServices.deviceApi.listDirectories(deviceId, path),
    [resolvedServices]
  )

  const loadEnvironmentInfo = useCallback(
    (project: ProjectWithTasks | null) =>
      loadProjectEnvironment(resolvedServices.deviceApi, project),
    [resolvedServices]
  )

  const commitEnvironmentChanges = useCallback(
    (project: ProjectWithTasks | null, message: string) =>
      commitProjectChanges(resolvedServices.deviceApi, project, message),
    [resolvedServices]
  )

  const sendCurrentInput = useCallback(async () => {
    const trimmedMessage = state.input.trim()
    const hasAttachments = attachmentSelection.attachments.length > 0
    if ((!trimmedMessage && !hasAttachments) || !state.defaultTeam) return
    const message = trimmedMessage || '请参考附件'

    dispatch({ type: 'sending_started' })
    dispatch({ type: 'input_changed', input: '' })
    dispatchMessages({
      type: 'user_added',
      message: {
        id: `local-${Date.now()}`,
        taskId: state.currentTask?.id,
        role: 'user',
        content: message,
        status: 'done',
        createdAt: new Date().toISOString(),
      },
    })

    const activeDeviceId =
      state.currentTask?.device_id ??
      state.currentProject?.config?.execution?.deviceId ??
      state.currentProject?.config?.device_id ??
      (!state.currentProject ? state.standaloneDeviceId ?? undefined : undefined)

    const payload: ChatSendPayload = {
      task_id: state.currentTask?.id,
      team_id: state.defaultTeam.id,
      project_id: state.currentTask ? undefined : state.currentProject?.id,
      client_origin: WEWORK_CLIENT_ORIGIN,
      device_id: activeDeviceId,
      task_type: 'code',
      message,
    }

    if (modelSelection.selectedModel) {
      payload.force_override_bot_model = modelSelection.selectedModel.name
      payload.force_override_bot_model_type = modelSelection.selectedModel.type
      if (Object.keys(modelSelection.selectedModelOptions).length > 0) {
        payload.model_options = modelSelection.selectedModelOptions
      }
    }

    if (!isOptionsLocked && skillSelection.selectedSkills.length > 0) {
      payload.additional_skills = skillSelection.selectedSkills
    }

    if (attachmentSelection.attachments.length > 0) {
      payload.attachment_ids = attachmentSelection.attachments.map(attachment => attachment.id)
    }

    const ack = await resolvedServices.chatStream.sendMessage(payload)
    dispatch({ type: 'sending_finished' })

    if (ack.error || ack.success === false) {
      dispatch({ type: 'error_set', error: ack.error ?? '发送失败' })
      return
    }

    attachmentSelection.resetAttachments()

    if (!state.currentTask && ack.task_id) {
      const projectId = state.currentProject?.id ?? 0
      const openedTask: Task = {
        id: ack.task_id,
        title: message.substring(0, 100),
        status: 'RUNNING',
        task_type: 'code',
        team_id: state.defaultTeam.id,
        project_id: projectId,
        client_origin: WEWORK_CLIENT_ORIGIN,
        device_id: activeDeviceId,
        model_id: payload.force_override_bot_model,
        force_override_bot_model_type: payload.force_override_bot_model_type,
        model_options: payload.model_options,
        created_at: new Date().toISOString(),
      }
      dispatch({
        type: 'task_opened',
        task: openedTask,
      })
      dispatch({
        type: 'task_status_changed',
        taskId: ack.task_id,
        status: 'RUNNING',
      })
      await refreshWorkLists()
      dispatch({ type: 'task_upserted', task: openedTask })
    }
  }, [
    attachmentSelection,
    refreshWorkLists,
    isOptionsLocked,
    modelSelection.selectedModel,
    modelSelection.selectedModelOptions,
    resolvedServices,
    skillSelection.selectedSkills,
    state.currentProject,
    state.currentTask,
    state.defaultTeam,
    state.input,
    state.standaloneDeviceId,
  ])

  const runningTaskIds = useMemo(() => {
    const ids = new Set<number>()
    if (state.currentTask && isRunningTaskStatus(state.currentTask.status)) {
      ids.add(state.currentTask.id)
    }
    for (const message of messages) {
      if (
        message.role === 'assistant' &&
        message.status === 'streaming' &&
        message.taskId
      ) {
        ids.add(message.taskId)
      }
    }
    return ids
  }, [messages, state.currentTask])

  const value: WorkbenchContextValue = {
    state,
    messages,
    runningTaskIds,
    projectChat: {
      models: modelSelection.models,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
    },
    selectProject,
    selectStandaloneDevice,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openTask,
    rememberExecutionDevice,
    refreshWorkLists,
    refreshDevices,
    createProject,
    updateProjectName,
    removeProject,
    archiveAllChats,
    archiveAllProjectChats,
    archiveProjectChats,
    archiveTask,
    renameTask,
    listArchivedTasks,
    unarchiveTask,
    deleteTask,
    deleteArchivedTasks,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    loadEnvironmentInfo,
    commitEnvironmentChanges,
    setInput,
    sendCurrentInput,
  }

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  )
}
