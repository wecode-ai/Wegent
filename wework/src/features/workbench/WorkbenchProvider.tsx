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
import { getRuntimeConfig } from '@/config/runtime'
import { createChatStream } from '@/stream/chatStream'
import { createSocketClient } from '@/stream/socketClient'
import type {
  Attachment,
  ArchivedTaskListResponse,
  ChatSendPayload,
  CreateProjectRequest,
  ProjectWithTasks,
  SkillRef,
  Subtask,
  Task,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import { messageReducer, normalizeBlockStatus } from './messageReducer'
import {
  initialWorkbenchState,
  workbenchReducer,
} from './workbenchReducer'
import { WorkbenchContext } from './useWorkbench'

export interface WorkbenchServices {
  teamApi: ReturnType<typeof createTeamApi>
  modelApi: ReturnType<typeof createModelApi>
  skillApi: ReturnType<typeof createSkillApi>
  projectApi: ReturnType<typeof createProjectApi>
  taskApi: ReturnType<typeof createTaskApi>
  deviceApi: ReturnType<typeof createDeviceApi>
  chatStream: ReturnType<typeof createChatStream>
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  projectChat: {
    models: UnifiedModel[]
    skills: UnifiedSkill[]
    selectedModel: UnifiedModel | null
    selectedSkills: SkillRef[]
    attachments: Attachment[]
    uploadingFiles: Map<string, { file: File; progress: number }>
    errors: Map<string, string>
    isOptionsLocked: boolean
    isAttachmentReadyToSend: boolean
    setSelectedModel: (model: UnifiedModel | null) => void
    setSelectedSkills: (skills: SkillRef[]) => void
    toggleSkill: (skill: SkillRef) => void
    handleFileSelect: (files: File | File[]) => Promise<void>
    addExistingAttachment: (attachment: Attachment) => void
    removeAttachment: (attachmentId: number) => Promise<void>
    resetAttachments: () => void
  }
  selectProject: (projectId: number) => void
  startNewProjectChat: (projectId: number) => void
  openTask: (taskId: number, projectId?: number) => Promise<void>
  refreshWorkLists: () => Promise<void>
  createProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  updateProjectName: (projectId: number, name: string) => Promise<void>
  removeProject: (projectId: number) => Promise<void>
  archiveAllChats: () => Promise<void>
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
    chatStream: createChatStream(socket),
  }
}

function subtaskToMessage(subtask: Subtask): WorkbenchMessage {
  const result = subtask.result as { value?: string } | undefined
  return {
    id: `subtask-${subtask.id}`,
    subtaskId: subtask.id,
    role: subtask.role === 'user' ? 'user' : 'assistant',
    content: subtask.prompt || result?.value || '',
    status: subtask.status === 'FAILED' ? 'failed' : 'done',
    createdAt: subtask.created_at,
  }
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
  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: isOptionsLocked,
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

      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects: projectsResult.status === 'fulfilled' ? projectsResult.value.items : [],
        devices: devicesResult.status === 'fulfilled' ? devicesResult.value : [],
        recentTasks:
          recentTasksResult.status === 'fulfilled' ? recentTasksResult.value.items : [],
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
    })
  }, [resolvedServices])

  useEffect(() => {
    return resolvedServices.chatStream.subscribe({
      onChatStart: payload =>
        dispatchMessages({
          type: 'assistant_started',
          taskId: payload.task_id,
          subtaskId: payload.subtask_id,
        }),
      onChatChunk: payload =>
        dispatchMessages({
          type: 'assistant_chunk',
          subtaskId: payload.subtask_id,
          content: payload.content,
        }),
      onChatDone: payload =>
        dispatchMessages({
          type: 'assistant_done',
          subtaskId: payload.subtask_id,
          content:
            typeof payload.result.value === 'string'
              ? payload.result.value
              : undefined,
        }),
      onChatError: payload =>
        dispatchMessages({
          type: 'assistant_error',
          subtaskId: payload.subtask_id,
          error: payload.error,
        }),
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
  }, [resolvedServices])

  const selectProject = useCallback(
    (projectId: number) => {
      const project = state.projects.find(item => item.id === projectId)
      if (project) {
        dispatch({ type: 'project_selected', project })
        dispatchMessages({ type: 'reset', messages: [] })
      }
    },
    [state.projects]
  )

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
      const project = projectId
        ? state.projects.find(item => item.id === projectId) ?? null
        : undefined
      dispatch({ type: 'task_opened', task: detail as Task, project })
      dispatchMessages({
        type: 'reset',
        messages: (detail.subtasks ?? []).map(subtaskToMessage),
      })
      await resolvedServices.chatStream.joinTask(taskId)
    },
    [resolvedServices, state.projects]
  )

  const setInput = useCallback((input: string) => {
    dispatch({ type: 'input_changed', input })
  }, [])

  const createProject = useCallback(
    async (data: CreateProjectRequest) => {
      const project = await resolvedServices.projectApi.createProject(data)
      await refreshWorkLists()
      dispatch({ type: 'project_selected', project })
      dispatchMessages({ type: 'reset', messages: [] })
      return project
    },
    [refreshWorkLists, resolvedServices]
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
    await refreshWorkLists()
    dispatch({ type: 'current_task_cleared' })
    dispatchMessages({ type: 'reset', messages: [] })
  }, [refreshWorkLists, resolvedServices])

  const archiveProjectChats = useCallback(
    async (projectId: number) => {
      await resolvedServices.projectApi.archiveProjectChats(projectId)
      await refreshWorkLists()
      dispatch({ type: 'current_task_cleared' })
      dispatchMessages({ type: 'reset', messages: [] })
    },
    [refreshWorkLists, resolvedServices]
  )

  const archiveTask = useCallback(
    async (taskId: number) => {
      await resolvedServices.taskApi.archiveTask(taskId)
      await refreshWorkLists()
      if (state.currentTask?.id === taskId) {
        dispatch({ type: 'current_task_cleared' })
        dispatchMessages({ type: 'reset', messages: [] })
      }
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

    const payload: ChatSendPayload = {
      task_id: state.currentTask?.id,
      team_id: state.defaultTeam.id,
      project_id: state.currentTask ? undefined : state.currentProject?.id,
      device_id: state.currentProject?.config?.execution?.deviceId ?? state.currentProject?.config?.device_id,
      task_type: 'code',
      message,
    }

    if (!isOptionsLocked && modelSelection.selectedModel) {
      payload.force_override_bot_model = modelSelection.selectedModel.name
      payload.force_override_bot_model_type = modelSelection.selectedModel.type
    }

    if (!isOptionsLocked && skillSelection.selectedSkills.length > 0) {
      payload.additional_skills = skillSelection.selectedSkills
    }

    if (attachmentSelection.attachments.length > 0) {
      payload.attachment_ids = attachmentSelection.attachments.map(attachment => attachment.id)
    }

    const ack = await resolvedServices.chatStream.sendMessage(payload)
    dispatch({ type: 'sending_finished' })

    if (!ack.success) {
      dispatch({ type: 'error_set', error: ack.error ?? '发送失败' })
      return
    }

    attachmentSelection.resetAttachments()

    if (!state.currentTask && ack.task_id) {
      dispatch({
        type: 'task_opened',
        task: {
          id: ack.task_id,
          title: message.substring(0, 100),
          status: 'RUNNING',
          task_type: 'code',
          team_id: state.defaultTeam.id,
          project_id: state.currentProject?.id,
          created_at: new Date().toISOString(),
        },
      })
    }
  }, [
    attachmentSelection,
    isOptionsLocked,
    modelSelection.selectedModel,
    resolvedServices,
    skillSelection.selectedSkills,
    state.currentProject?.id,
    state.currentProject?.config,
    state.currentTask,
    state.defaultTeam,
    state.input,
  ])

  const value: WorkbenchContextValue = {
    state,
    messages,
    projectChat: {
      models: modelSelection.models,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
    },
    selectProject,
    startNewProjectChat,
    openTask,
    refreshWorkLists,
    createProject,
    updateProjectName,
    removeProject,
    archiveAllChats,
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
