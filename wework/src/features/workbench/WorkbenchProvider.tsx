import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'
import { createAuthApi } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { createProjectApi } from '@/api/projects'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { getRuntimeConfig } from '@/config/runtime'
import { createChatStream } from '@/stream/chatStream'
import { createSocketClient } from '@/stream/socketClient'
import type { ChatSendPayload, Subtask, Task } from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { messageReducer } from './messageReducer'
import {
  initialWorkbenchState,
  workbenchReducer,
} from './workbenchReducer'
import { WorkbenchContext } from './useWorkbench'

export interface WorkbenchServices {
  authApi: ReturnType<typeof createAuthApi>
  teamApi: ReturnType<typeof createTeamApi>
  projectApi: ReturnType<typeof createProjectApi>
  taskApi: ReturnType<typeof createTaskApi>
  chatStream: ReturnType<typeof createChatStream>
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  selectProject: (projectId: number) => void
  openTask: (taskId: number) => Promise<void>
  setInput: (input: string) => void
  sendCurrentInput: () => Promise<void>
}

interface WorkbenchProviderProps {
  children: ReactNode
  services?: WorkbenchServices
}

function createDefaultServices(): WorkbenchServices {
  const { apiBaseUrl } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
  const socket = createSocketClient()

  return {
    authApi: createAuthApi(client),
    teamApi: createTeamApi(client),
    projectApi: createProjectApi(client),
    taskApi: createTaskApi(client),
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

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const [user, defaultTeam, projects, recentTasks] = await Promise.all([
          resolvedServices.authApi.getCurrentUser(),
          resolvedServices.teamApi.getDefaultWorkbenchTeam(),
          resolvedServices.projectApi.listProjects(),
          resolvedServices.taskApi.listRecentTasks({ limit: 20 }),
        ])

        if (!cancelled) {
          dispatch({
            type: 'bootstrapped',
            user,
            defaultTeam,
            projects: projects.items,
            recentTasks: recentTasks.items,
          })
        }
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: 'bootstrap_failed',
            error: error instanceof Error ? error.message : '初始化失败',
          })
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
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
    })
  }, [resolvedServices])

  const selectProject = useCallback(
    (projectId: number) => {
      const project = state.projects.find(item => item.id === projectId)
      if (project) dispatch({ type: 'project_selected', project })
    },
    [state.projects]
  )

  const openTask = useCallback(
    async (taskId: number) => {
      const detail = await resolvedServices.taskApi.getTaskDetail(taskId)
      dispatch({ type: 'task_opened', task: detail as Task })
      dispatchMessages({
        type: 'reset',
        messages: (detail.subtasks ?? []).map(subtaskToMessage),
      })
      await resolvedServices.chatStream.joinTask(taskId)
    },
    [resolvedServices]
  )

  const setInput = useCallback((input: string) => {
    dispatch({ type: 'input_changed', input })
  }, [])

  const sendCurrentInput = useCallback(async () => {
    const message = state.input.trim()
    if (!message || !state.defaultTeam) return

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
      project_id: state.currentProject?.id,
      task_type: 'code',
      message,
    }

    const ack = await resolvedServices.chatStream.sendMessage(payload)
    dispatch({ type: 'sending_finished' })

    if (!ack.success) {
      dispatch({ type: 'error_set', error: ack.error ?? '发送失败' })
    }
  }, [
    resolvedServices,
    state.currentProject?.id,
    state.currentTask?.id,
    state.defaultTeam,
    state.input,
  ])

  const value: WorkbenchContextValue = {
    state,
    messages,
    selectProject,
    openTask,
    setInput,
    sendCurrentInput,
  }

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  )
}
