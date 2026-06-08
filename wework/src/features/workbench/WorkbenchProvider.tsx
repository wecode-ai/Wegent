import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createDeviceApi } from '@/api/devices'
import {
  checkoutProjectBranch,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
} from '@/api/environment'
import { createGitApi } from '@/api/git'
import { createHttpClient } from '@/api/http'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { createChatStream } from '@/stream/chatStream'
import { createSocketClient } from '@/stream/socketClient'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { buildTaskRoute, navigateTo, parseTaskRoute } from '@/lib/navigation'
import type {
  Attachment,
  ArchivedTaskListResponse,
  ChatSendPayload,
  ChatBlock,
  CreateProjectRequest,
  CreateGitWorkspaceProjectRequest,
  GitBranch,
  GitRepoInfo,
  DeviceInfo,
  LocalDeviceSkill,
  ModelOptions,
  ModelSelectionConfig,
  ProjectWithTasks,
  SkillRef,
  Subtask,
  Task,
  TaskDetail,
  TaskListResponse,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type {
  GuidanceWorkbenchMessage,
  ProcessingBlock,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
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
const LOCAL_SKILLS_CACHE_TTL_MS = 60_000

interface QueuedWorkbenchSend extends QueuedWorkbenchMessage {
  payload: ChatSendPayload
  activeDeviceId?: string
  attachments?: Attachment[]
}

export interface WorkbenchServices {
  teamApi: ReturnType<typeof createTeamApi>
  modelApi: ReturnType<typeof createModelApi>
  skillApi: ReturnType<typeof createSkillApi>
  projectApi: Omit<
    ReturnType<typeof createProjectApi>,
    'createGitWorkspaceProject'
  > & {
    createGitWorkspaceProject?: ReturnType<
      typeof createProjectApi
    >['createGitWorkspaceProject']
  }
  gitApi?: ReturnType<typeof createGitApi>
  taskApi: Omit<ReturnType<typeof createTaskApi>, 'searchTasks'> & {
    searchTasks?: ReturnType<typeof createTaskApi>['searchTasks']
  }
  deviceApi: ReturnType<typeof createDeviceApi>
  userApi?: ReturnType<typeof createUserApi>
  chatStream: ReturnType<typeof createChatStream>
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
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
    listLocalSkills: () => Promise<LocalDeviceSkill[]>
  }
  runningTaskIds: Set<number>
  selectProject: (projectId: number | null) => void
  selectStandaloneDevice: (deviceId: string | null) => void
  startNewChat: () => void
  startStandaloneChat: () => void
  startNewProjectChat: (projectId: number) => void
  openTask: (taskId: number, projectId?: number) => Promise<void>
  searchTasks: (query: string) => Promise<TaskListResponse>
  searchTaskDetail: (taskId: number) => Promise<TaskDetail>
  rememberExecutionDevice: (deviceId: string) => void
  refreshWorkLists: () => Promise<void>
  refreshDevices: () => Promise<void>
  createProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  createGitWorkspaceProject: (
    data: CreateGitWorkspaceProjectRequest,
  ) => Promise<ProjectWithTasks>
  listGitRepositories: () => Promise<GitRepoInfo[]>
  listGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
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
  createDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  loadEnvironmentInfo: (project: ProjectWithTasks | null) => Promise<EnvironmentInfo>
  commitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
  ) => Promise<void>
  listEnvironmentBranches: (project: ProjectWithTasks | null) => Promise<string[]>
  checkoutEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
  ) => Promise<void>
  createEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
  ) => Promise<void>
  setInput: (input: string) => void
  sendCurrentInput: () => Promise<void>
  pauseCurrentResponse: () => Promise<void>
  isResponseStreaming: boolean
  cancelQueuedMessage: (id: string) => void
  sendQueuedAsGuidance: (id: string) => Promise<void>
  editQueuedMessage: (id: string) => void
  cancelGuidanceMessage: (id: string) => void
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
    gitApi: createGitApi(client),
    taskApi: createTaskApi(client),
    deviceApi: createDeviceApi(client),
    userApi: createUserApi(client),
    chatStream: createChatStream(socket),
  }
}

function getCurrentAppPath(): string {
  return stripAppBasePath(window.location.pathname)
}

function getTaskRouteKey(taskId: number, projectId?: number): string {
  return `${projectId ?? 0}:${taskId}`
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

function getBlockTimestamp(value: unknown): number {
  if (typeof value !== 'number') return Date.now()
  return value > 1_000_000_000_000 ? value : Date.now()
}

function normalizeProcessingBlock(
  subtaskId: number,
  block: unknown,
  index: number
): ProcessingBlock | null {
  if (!isRecord(block)) return null

  const timestamp = getBlockTimestamp(block.timestamp)
  const status = normalizeBlockStatus(
    typeof block.status === 'string' ? block.status : undefined
  )

  if (block.type === 'tool') {
    const id =
      typeof block.id === 'string'
        ? block.id
        : typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : `tool-${subtaskId}-${index}`
    return {
      id,
      subtaskId,
      type: 'tool',
      toolName: typeof block.tool_name === 'string' ? block.tool_name : 'unknown',
      toolInput: isRecord(block.tool_input) ? block.tool_input : undefined,
      toolOutput: block.tool_output,
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'thinking') {
    const id =
      typeof block.id === 'string' ? block.id : `thinking-${subtaskId}-${index}`
    return {
      id,
      subtaskId,
      type: 'thinking',
      content: typeof block.content === 'string' ? block.content : '',
      status,
      createdAt: timestamp,
    }
  }

  return null
}

function normalizeProcessingBlocks(
  subtaskId: number,
  blocks?: unknown[]
): ProcessingBlock[] {
  if (!blocks) return []

  return blocks.flatMap((block, index) => {
    const normalized = normalizeProcessingBlock(subtaskId, block, index)
    return normalized ? [normalized] : []
  })
}

function getResultBlocks(
  subtaskId: number,
  result: unknown
): ProcessingBlock[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.blocks)) return undefined
  const blocks = normalizeProcessingBlocks(subtaskId, result.blocks)
  return blocks.length > 0 ? blocks : undefined
}

function getReasoningChunk(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  return typeof result.reasoning_chunk === 'string'
    ? result.reasoning_chunk
    : undefined
}

function normalizeChatBlock(
  subtaskId: number,
  block: ChatBlock
): ProcessingBlock | null {
  return normalizeProcessingBlock(subtaskId, block, 0)
}

function normalizeAttachmentStatus(status?: string): Attachment['status'] {
  const normalized = status?.toLowerCase()
  if (
    normalized === 'uploading' ||
    normalized === 'parsing' ||
    normalized === 'ready' ||
    normalized === 'failed'
  ) {
    return normalized
  }

  return 'ready'
}

function getSubtaskAttachments(subtask: Subtask): Attachment[] | undefined {
  if (subtask.attachments && subtask.attachments.length > 0) {
    return subtask.attachments
  }

  const attachments = (subtask.contexts ?? [])
    .filter(context => context.context_type === 'attachment')
    .map(context => ({
      id: context.id,
      filename: context.name,
      file_size: context.file_size ?? 0,
      mime_type: context.mime_type ?? 'application/octet-stream',
      status: normalizeAttachmentStatus(context.status),
      subtask_id: subtask.id,
      file_extension: context.file_extension ?? '',
      created_at: subtask.created_at,
    }))

  return attachments.length > 0 ? attachments : undefined
}

function subtaskToMessage(subtask: Subtask): WorkbenchMessage {
  const result = getSubtaskResult(subtask.result)
  const role = subtask.role.toLowerCase() === 'user' ? 'user' : 'assistant'
  const blocks = normalizeProcessingBlocks(subtask.id, result?.blocks)
  return {
    id: `subtask-${subtask.id}`,
    taskId: subtask.task_id,
    subtaskId: subtask.id,
    role,
    content: subtask.prompt || result?.value || '',
    status: subtask.status === 'FAILED' ? 'failed' : 'done',
    attachments: getSubtaskAttachments(subtask),
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

function readTaskIdFromUrl(): number | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const value = params.get('taskId') || params.get('task_id') || params.get('taskid')
  if (!value) return null
  const taskId = Number(value)
  return Number.isFinite(taskId) && taskId > 0 ? taskId : null
}

function writeTaskIdToUrl(taskId: number | null) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.delete('task_id')
  url.searchParams.delete('taskid')
  if (taskId) {
    url.searchParams.set('taskId', String(taskId))
  } else {
    url.searchParams.delete('taskId')
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
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

function normalizeStoredModelOptions(
  options?: Record<string, unknown> | null,
): ModelOptions {
  if (!options) return {}
  return Object.fromEntries(
    Object.entries(options).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    }),
  )
}

function getTaskModelSelection(task: Task | null): ModelSelectionConfig | null {
  if (!task?.model_id) return null
  return {
    modelName: task.model_id,
    modelType: task.force_override_bot_model_type ?? null,
    options: normalizeStoredModelOptions(task.model_options),
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

function normalizeGuidanceError(error?: string) {
  if (!error) return '引导发送失败'
  if (error.includes('Chat Shell')) {
    return '当前智能体不支持引导，请编辑后排队发送'
  }
  if (error.includes('Subtask not found')) {
    return '当前回复已结束，请编辑后重新发送'
  }
  if (error.includes('Not connected') || error.includes('连接未建立')) {
    return '连接未建立，请稍后重试'
  }
  return error
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
  const [queuedSends, setQueuedSends] = useState<QueuedWorkbenchSend[]>([])
  const [guidanceMessages, setGuidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])
  const [isAwaitingAssistantStart, setIsAwaitingAssistantStart] = useState(false)
  const [routePath, setRoutePath] = useState(getCurrentAppPath)
  const guidanceSendInFlightRef = useRef(false)
  const localSkillsCacheRef = useRef<
    Map<string, { expiresAt: number; skills: LocalDeviceSkill[] }>
  >(new Map())
  const handledTaskRouteRef = useRef<string | null>(null)
  const urlTaskOpenAttemptRef = useRef<number | null>(null)
  const isOptionsLocked = Boolean(state.currentTask)
  const currentUser = state.user ?? user
  const activeDeviceId =
    state.currentTask?.device_id ??
    state.currentProject?.config?.execution?.deviceId ??
    state.currentProject?.config?.device_id ??
    (!state.currentProject ? state.standaloneDeviceId ?? undefined : undefined)
  const modelSelectionConfig = useMemo(
    () =>
      getTaskModelSelection(state.currentTask) ??
      getNewChatModelSelection(currentUser) ??
      null,
    [currentUser, state.currentTask]
  )
  const persistNewChatModelSelection = useCallback(
    (selection: ModelSelectionConfig) => {
      if (state.currentTask) return
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
    [currentUser.preferences, resolvedServices.userApi, state.currentTask]
  )
  useEffect(() => {
    const handlePopState = () => setRoutePath(getCurrentAppPath())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: false,
    selectionConfig: modelSelectionConfig,
    selectionReady: !state.isBootstrapping,
    onSelectionChange: persistNewChatModelSelection,
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
        setIsAwaitingAssistantStart(false)
        dispatch({
          type: 'task_status_changed',
          taskId: payload.task_id,
          status: 'RUNNING',
        })
        dispatchMessages({
          type: 'assistant_started',
          taskId: payload.task_id,
          subtaskId: payload.subtask_id,
          shellType: payload.shell_type,
        })
      },
      onChatChunk: payload =>
        dispatchMessages({
          type: 'assistant_chunk',
          subtaskId: payload.subtask_id,
          content: payload.content,
          reasoningChunk: getReasoningChunk(payload.result),
          blocks: getResultBlocks(payload.subtask_id, payload.result),
        }),
      onChatDone: payload => {
        setIsAwaitingAssistantStart(false)
        const taskId = payload.task_id ?? state.currentTask?.id
        if (taskId) {
          dispatch({
            type: 'task_status_changed',
            taskId,
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
          blocks: getResultBlocks(payload.subtask_id, payload.result),
        })
      },
      onChatError: payload => {
        setIsAwaitingAssistantStart(false)
        const taskId = payload.task_id ?? state.currentTask?.id
        if (taskId) {
          dispatch({
            type: 'task_status_changed',
            taskId,
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
        const block = normalizeChatBlock(payload.subtask_id, payload.block)
        if (!block) return
        dispatchMessages({
          type: 'block_created',
          subtaskId: payload.subtask_id,
          block,
        })
      },
      onBlockUpdated: payload => {
        dispatchMessages({
          type: 'block_updated',
          subtaskId: payload.subtask_id,
          blockId: payload.block_id,
          updates: {
            ...(payload.content !== undefined && { content: payload.content }),
            ...(payload.tool_input !== undefined && { toolInput: payload.tool_input }),
            ...(payload.tool_output !== undefined && { toolOutput: payload.tool_output }),
            ...(payload.status && { status: normalizeBlockStatus(payload.status) }),
          },
        })
      },
      onGuidanceQueued: payload => {
        setGuidanceMessages(items =>
          items.map(item =>
            item.id === payload.guidance_id ||
            item.id === payload.client_guidance_id
              ? {
                  ...item,
                  id: payload.guidance_id,
                  content: payload.message ?? payload.content ?? item.content,
                  status: 'queued',
                }
              : item
          )
        )
      },
      onGuidanceApplied: payload => {
        setGuidanceMessages(items =>
          items.filter(item =>
            item.id !== payload.guidance_id &&
            item.id !== payload.client_guidance_id
          )
        )
      },
      onGuidanceExpired: payload => {
        setGuidanceMessages(items =>
          items.map(item =>
            payload.guidance_ids.includes(item.id)
              ? { ...item, status: 'expired' }
              : item
          )
        )
      },
    })
  }, [refreshDevices, resolvedServices, state.currentTask?.id])

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
      writeTaskIdToUrl(null)
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
        setQueuedSends([])
        setGuidanceMessages([])
        handledTaskRouteRef.current = null
        navigateTo('/')
        return
      }
      const project = state.projects.find(item => item.id === projectId)
      if (project) {
        writeLastProjectId(user.id, project.id)
        dispatch({ type: 'project_selected', project })
        dispatchMessages({ type: 'reset', messages: [] })
        setQueuedSends([])
        setGuidanceMessages([])
        handledTaskRouteRef.current = null
        navigateTo('/')
      }
    },
    [state.devices, state.projects, state.standaloneDeviceId, user]
  )

  const selectStandaloneDevice = useCallback(
    (deviceId: string | null) => {
      writeTaskIdToUrl(null)
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
      setQueuedSends([])
      setGuidanceMessages([])
      handledTaskRouteRef.current = null
      navigateTo('/')
    },
    [
      rememberExecutionDevice,
      state.devices,
      state.standaloneDeviceId,
      user.preferences?.default_execution_target,
    ]
  )

  const startNewChat = useCallback(() => {
    writeTaskIdToUrl(null)
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
    setQueuedSends([])
    setGuidanceMessages([])
    handledTaskRouteRef.current = null
    navigateTo('/')
  }, [state.devices, state.projects, state.standaloneDeviceId, user])

  const startStandaloneChat = useCallback(() => {
    writeTaskIdToUrl(null)
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
    })
    dispatchMessages({ type: 'reset', messages: [] })
    setQueuedSends([])
    setGuidanceMessages([])
    handledTaskRouteRef.current = null
    navigateTo('/')
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
      setQueuedSends([])
      setGuidanceMessages([])
      writeTaskIdToUrl(taskId)
      await resolvedServices.chatStream.joinTask(taskId)
      const routeProjectId =
        resolvedProjectId && resolvedProjectId > 0 ? resolvedProjectId : undefined
      handledTaskRouteRef.current = getTaskRouteKey(taskId, routeProjectId)
      navigateTo(buildTaskRoute({ taskId, projectId: routeProjectId }))
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

  const searchTaskDetail = useCallback(
    (taskId: number) => resolvedServices.taskApi.getTaskDetail(taskId),
    [resolvedServices]
  )

  useEffect(() => {
    if (state.isBootstrapping) return

    const taskRoute = parseTaskRoute(routePath)
    if (!taskRoute) return

    const routeKey = getTaskRouteKey(taskRoute.taskId, taskRoute.projectId)
    if (handledTaskRouteRef.current === routeKey) return

    if (
      state.currentTask?.id === taskRoute.taskId &&
      (taskRoute.projectId === undefined ||
        state.currentTask.project_id === taskRoute.projectId)
    ) {
      handledTaskRouteRef.current = routeKey
      return
    }

    handledTaskRouteRef.current = routeKey
    void openTask(taskRoute.taskId, taskRoute.projectId)
  }, [
    openTask,
    routePath,
    state.currentTask?.id,
    state.currentTask?.project_id,
    state.isBootstrapping,
  ])

  const searchTasks = useCallback(
    (query: string) =>
      resolvedServices.taskApi.searchTasks?.(query, { limit: 30 }) ??
      Promise.resolve({ total: 0, items: [] }),
    [resolvedServices]
  )

  useEffect(() => {
    if (state.isBootstrapping) return
    const taskId = readTaskIdFromUrl()
    if (!taskId || state.currentTask?.id === taskId) return
    if (urlTaskOpenAttemptRef.current === taskId) return

    urlTaskOpenAttemptRef.current = taskId
    void openTask(taskId).catch(error => {
      dispatch({
        type: 'error_set',
        error: error instanceof Error ? error.message : '会话加载失败',
      })
      writeTaskIdToUrl(null)
      if (urlTaskOpenAttemptRef.current === taskId) {
        urlTaskOpenAttemptRef.current = null
      }
    })
  }, [openTask, state.currentTask?.id, state.isBootstrapping])

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
      setQueuedSends([])
      setGuidanceMessages([])
      return project
    },
    [refreshWorkLists, rememberExecutionDevice, resolvedServices, user.id]
  )

  const createGitWorkspaceProject = useCallback(
    async (data: CreateGitWorkspaceProjectRequest) => {
      if (!resolvedServices.projectApi.createGitWorkspaceProject) {
        throw new Error('Git workspace project creation is unavailable')
      }
      const response = await resolvedServices.projectApi.createGitWorkspaceProject(data)
      const project: ProjectWithTasks = {
        ...response.project,
        tasks: response.project.tasks ?? [],
      }
      rememberExecutionDevice(data.device_id)
      await refreshWorkLists()
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      return project
    },
    [refreshWorkLists, rememberExecutionDevice, resolvedServices, user.id]
  )

  const listGitRepositories = useCallback(
    () => resolvedServices.gitApi?.listRepositories() ?? Promise.resolve([]),
    [resolvedServices]
  )

  const listGitBranches = useCallback(
    (repo: GitRepoInfo) => resolvedServices.gitApi?.listBranches(repo) ?? Promise.resolve([]),
    [resolvedServices]
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
      writeTaskIdToUrl(null)
      dispatch({ type: 'current_task_cleared' })
      dispatchMessages({ type: 'reset', messages: [] })
    }
    await refreshWorkLists()
  }, [refreshWorkLists, resolvedServices, state.currentProject, state.currentTask])

  const archiveAllProjectChats = useCallback(async () => {
    await resolvedServices.projectApi.archiveAllProjectChats()
    if (state.currentProject || (state.currentTask?.project_id ?? 0) > 0) {
      writeTaskIdToUrl(null)
      dispatch({ type: 'current_task_cleared' })
      dispatchMessages({ type: 'reset', messages: [] })
    }
    await refreshWorkLists()
  }, [refreshWorkLists, resolvedServices, state.currentProject, state.currentTask?.project_id])

  const archiveProjectChats = useCallback(
    async (projectId: number) => {
      await resolvedServices.projectApi.archiveProjectChats(projectId)
      writeTaskIdToUrl(null)
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
        writeTaskIdToUrl(null)
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
      if (state.currentTask?.id === taskId) {
        writeTaskIdToUrl(null)
        dispatch({ type: 'current_task_cleared' })
        dispatchMessages({ type: 'reset', messages: [] })
      }
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices, state.currentTask?.id]
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

  const createDeviceDirectory = useCallback(
    (deviceId: string, path: string) =>
      resolvedServices.deviceApi.createDirectory(deviceId, path),
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

  const listEnvironmentBranches = useCallback(
    (project: ProjectWithTasks | null) =>
      listProjectBranches(resolvedServices.deviceApi, project),
    [resolvedServices]
  )

  const checkoutEnvironmentBranch = useCallback(
    (project: ProjectWithTasks | null, branchName: string) =>
      checkoutProjectBranch(resolvedServices.deviceApi, project, branchName),
    [resolvedServices]
  )

  const createEnvironmentBranch = useCallback(
    (project: ProjectWithTasks | null, branchName: string) =>
      createAndCheckoutProjectBranch(resolvedServices.deviceApi, project, branchName),
    [resolvedServices]
  )

  const activeAssistantMessage = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          message =>
            message.role === 'assistant' &&
            message.status === 'streaming' &&
            message.subtaskId &&
            (!state.currentTask || message.taskId === state.currentTask.id)
        ),
    [messages, state.currentTask]
  )
  const hasActiveTurn = Boolean(activeAssistantMessage)

  const buildSendPayload = useCallback(
    (message: string): { payload: ChatSendPayload; activeDeviceId?: string } | null => {
      if (!state.defaultTeam) return null

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

      return { payload, activeDeviceId }
    },
    [
      attachmentSelection.attachments,
      isOptionsLocked,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      skillSelection.selectedSkills,
      state.currentProject,
      state.currentTask,
      state.defaultTeam,
      state.standaloneDeviceId,
    ]
  )

  const sendPreparedMessage = useCallback(
    async (
      message: string,
      payload: ChatSendPayload,
      activeDeviceId?: string,
      attachments?: Attachment[]
    ): Promise<boolean> => {
      dispatch({ type: 'sending_started' })
      setIsAwaitingAssistantStart(true)
      dispatchMessages({
        type: 'user_added',
        message: {
          id: `local-${Date.now()}`,
          taskId: payload.task_id,
          role: 'user',
          content: message,
          status: 'done',
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          createdAt: new Date().toISOString(),
        },
      })

      let ack
      try {
        ack = await resolvedServices.chatStream.sendMessage(payload)
      } catch (error) {
        setIsAwaitingAssistantStart(false)
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : '发送失败',
        })
        return false
      } finally {
        dispatch({ type: 'sending_finished' })
      }

      if (ack.error || ack.success === false) {
        setIsAwaitingAssistantStart(false)
        dispatch({ type: 'error_set', error: ack.error ?? '发送失败' })
        return false
      }

      const activeTaskId = ack.task_id ?? payload.task_id
      if (activeTaskId) {
        dispatch({
          type: 'task_status_changed',
          taskId: activeTaskId,
          status: 'RUNNING',
        })
      }

      if (!state.currentTask && ack.task_id) {
        writeTaskIdToUrl(ack.task_id)
        const projectId = state.currentProject?.id ?? 0
        const openedTask: Task = {
          id: ack.task_id,
          title: message.substring(0, 100),
          status: 'RUNNING',
          task_type: 'code',
          team_id: payload.team_id,
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
        await refreshWorkLists()
        dispatch({ type: 'task_upserted', task: openedTask })
      }

      return true
    },
    [
      refreshWorkLists,
      resolvedServices.chatStream,
      state.currentProject?.id,
      state.currentTask,
    ]
  )

  const sendCurrentInput = useCallback(async () => {
    const trimmedMessage = state.input.trim()
    const hasAttachments = attachmentSelection.attachments.length > 0
    if (!trimmedMessage && !hasAttachments) return
    const message = trimmedMessage || '请参考附件'
    const prepared = buildSendPayload(message)
    if (!prepared) return
    const attachmentsSnapshot = hasAttachments
      ? [...attachmentSelection.attachments]
      : undefined

    dispatch({ type: 'input_changed', input: '' })

    if (hasActiveTurn && state.currentTask?.id) {
      setQueuedSends(items => [
        ...items,
        {
          id: `queued-${state.currentTask?.id}-${Date.now()}`,
          content: message,
          status: 'queued',
          createdAt: new Date().toISOString(),
          payload: prepared.payload,
          activeDeviceId: prepared.activeDeviceId,
          attachments: attachmentsSnapshot,
        },
      ])
      attachmentSelection.resetAttachments()
      return
    }

    const sent = await sendPreparedMessage(
      message,
      prepared.payload,
      prepared.activeDeviceId,
      attachmentsSnapshot
    )
    if (sent) {
      attachmentSelection.resetAttachments()
    }
  }, [
    attachmentSelection,
    buildSendPayload,
    hasActiveTurn,
    sendPreparedMessage,
    state.currentTask?.id,
    state.input,
  ])

  const sendNextQueuedMessage = useCallback(
    async (item: QueuedWorkbenchSend) => {
      setQueuedSends(items =>
        items.map(queued =>
          queued.id === item.id ? { ...queued, status: 'sending' } : queued
        )
      )

      const sent = await sendPreparedMessage(
        item.content,
        item.payload,
        item.activeDeviceId,
        item.attachments
      )

      setQueuedSends(items =>
        sent
          ? items.filter(queued => queued.id !== item.id)
          : items.map(queued =>
              queued.id === item.id
                ? { ...queued, status: 'failed', error: '发送失败' }
                : queued
            )
      )
    },
    [sendPreparedMessage]
  )

  useEffect(() => {
    const next = queuedSends.find(item => item.status === 'queued')
    if (!next || hasActiveTurn || isAwaitingAssistantStart || state.isSending) return

    const timer = window.setTimeout(() => {
      void sendNextQueuedMessage(next)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [
    hasActiveTurn,
    isAwaitingAssistantStart,
    queuedSends,
    sendNextQueuedMessage,
    state.isSending,
  ])

  const cancelQueuedMessage = useCallback((id: string) => {
    setQueuedSends(items => items.filter(item => item.id !== id))
  }, [])

  const editQueuedMessage = useCallback((id: string) => {
    const item = queuedSends.find(queued => queued.id === id)
    if (!item || item.status === 'sending') return

    dispatch({ type: 'input_changed', input: item.content })
    for (const attachment of item.attachments ?? []) {
      attachmentSelection.addExistingAttachment(attachment)
    }
    setQueuedSends(items => items.filter(queued => queued.id !== id))
  }, [attachmentSelection, queuedSends])

  const cancelGuidanceMessage = useCallback((id: string) => {
    setGuidanceMessages(items => items.filter(item => item.id !== id))
  }, [])

  const pauseCurrentResponse = useCallback(async () => {
    if (!activeAssistantMessage?.subtaskId) return

    const ack = await resolvedServices.chatStream.cancelStream({
      subtask_id: activeAssistantMessage.subtaskId,
      partial_content: activeAssistantMessage.content,
      shell_type: activeAssistantMessage.shellType,
    })

    if (ack.error || ack.success === false) {
      dispatch({
        type: 'error_set',
        error: normalizeGuidanceError(ack.error ?? '取消当前回复失败'),
      })
      return
    }

    dispatchMessages({
      type: 'assistant_done',
      subtaskId: activeAssistantMessage.subtaskId,
      content: activeAssistantMessage.content,
    })
    if (state.currentTask?.id) {
      dispatch({
        type: 'task_status_changed',
        taskId: state.currentTask.id,
        status: 'CANCELLED',
      })
    }
  }, [
    activeAssistantMessage,
    resolvedServices.chatStream,
    state.currentTask,
  ])

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      if (guidanceSendInFlightRef.current) return

      const item = queuedSends.find(queued => queued.id === id)
      const taskId = state.currentTask?.id ?? item?.payload.task_id
      const activeSubtaskId = activeAssistantMessage?.subtaskId
      if (!item) return

      if (!taskId || !activeSubtaskId || !state.defaultTeam) {
        setQueuedSends(items =>
          items.map(queued =>
            queued.id === id
              ? {
                  ...queued,
                  status: 'failed',
                  error: '当前没有可引导的回复',
                }
              : queued
          )
        )
        return
      }

      guidanceSendInFlightRef.current = true
      setQueuedSends(items =>
        items.map(queued =>
          queued.id === id
            ? { ...queued, status: 'sending', error: undefined }
            : queued
        )
      )

      try {
        const cancelAck = await resolvedServices.chatStream.cancelStream({
          subtask_id: activeSubtaskId,
          partial_content: activeAssistantMessage.content,
          shell_type: activeAssistantMessage.shellType,
        })

        if (cancelAck.error || cancelAck.success === false) {
          setQueuedSends(items =>
            items.map(queued =>
              queued.id === id
                ? {
                    ...queued,
                    status: 'failed',
                    error: normalizeGuidanceError(cancelAck.error ?? '取消当前回复失败'),
                  }
                : queued
            )
          )
          return
        }

        dispatchMessages({
          type: 'assistant_done',
          subtaskId: activeSubtaskId,
          content: activeAssistantMessage.content,
        })

        const sent = await sendPreparedMessage(
          item.content,
          item.payload,
          item.activeDeviceId,
          item.attachments
        )

        setQueuedSends(items =>
          !sent
            ? items.map(queued =>
                queued.id === id
                  ? {
                      ...queued,
                      status: 'failed',
                      error: '引导发送失败',
                    }
                  : queued
              )
            : items.filter(queued => queued.id !== id)
        )
      } catch (error) {
        setQueuedSends(items =>
          items.map(queued =>
            queued.id === id
              ? {
                  ...queued,
                  status: 'failed',
                  error: normalizeGuidanceError(
                    error instanceof Error ? error.message : '取消当前回复失败',
                  ),
                }
              : queued
          )
        )
      } finally {
        guidanceSendInFlightRef.current = false
      }
    },
    [
      activeAssistantMessage,
      queuedSends,
      resolvedServices.chatStream,
      sendPreparedMessage,
      state.currentTask?.id,
      state.defaultTeam,
    ]
  )

  const listLocalSkills = useCallback(async () => {
    if (!activeDeviceId) return []

    const cached = localSkillsCacheRef.current.get(activeDeviceId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.skills
    }

    const skills = await resolvedServices.deviceApi.listSkills(activeDeviceId)
    localSkillsCacheRef.current.set(activeDeviceId, {
      expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
      skills,
    })
    return skills
  }, [activeDeviceId, resolvedServices.deviceApi])

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
    queuedMessages: queuedSends,
    guidanceMessages,
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
      listLocalSkills,
    },
    selectProject,
    selectStandaloneDevice,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openTask,
    searchTasks,
    searchTaskDetail,
    rememberExecutionDevice,
    refreshWorkLists,
    refreshDevices,
    createProject,
    createGitWorkspaceProject,
    listGitRepositories,
    listGitBranches,
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
    createDeviceDirectory,
    loadEnvironmentInfo,
    commitEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    setInput,
    sendCurrentInput,
    pauseCurrentResponse,
    isResponseStreaming: hasActiveTurn,
    cancelQueuedMessage,
    sendQueuedAsGuidance,
    editQueuedMessage,
    cancelGuidanceMessage,
  }

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  )
}
