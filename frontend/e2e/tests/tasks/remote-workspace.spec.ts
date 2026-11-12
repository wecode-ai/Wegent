import { test, expect } from '@playwright/test'

import { ADMIN_USER } from '../../config/test-users'
import { createApiClient, ApiClient } from '../../utils/api-client'

type TeamItem = {
  id: number
  name: string
  bots: Array<{ bot_id: number }>
}

type TeamListResponse = {
  total: number
  items: TeamItem[]
}

type CreateTaskIdResponse = {
  task_id: number
}

type TaskDetailSubtask = {
  id: number
  role: string
  status: string
}

type TaskDetailResponse = {
  subtasks: TaskDetailSubtask[]
}

type RemoteWorkspaceStatusResponse = {
  connected: boolean
  available: boolean
  root_path: string
  reason: string | null
}

test.describe('Remote Workspace', () => {
  let apiClient: ApiClient
  let createdTaskId: string | null = null

  test.beforeEach(async ({ request }) => {
    apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
  })

  test.afterEach(async () => {
    if (createdTaskId) {
      await apiClient.deleteTask(createdTaskId)
      createdTaskId = null
    }
  })

  test('desktop chat shows a disabled workspace entry when the sandbox is unavailable', async ({
    page,
  }) => {
    const teamsResponse = await apiClient.get<TeamListResponse>(
      '/api/teams?page=1&limit=100&scope=all'
    )
    expect(teamsResponse.status).toBe(200)

    const teams = teamsResponse.data?.items ?? []
    const teamWithBots = teams.find(team => Array.isArray(team.bots) && team.bots.length > 0)
    expect(teamWithBots).toBeTruthy()

    const createTaskIdResponse = await apiClient.post<CreateTaskIdResponse>('/api/tasks')
    expect(createTaskIdResponse.status).toBe(200)
    const taskId = createTaskIdResponse.data?.task_id
    expect(taskId).toBeTruthy()

    createdTaskId = String(taskId)

    const createTaskResponse = await apiClient.post(`/api/tasks/${taskId}`, {
      prompt: 'e2e remote workspace unavailable state',
      team_id: teamWithBots?.id,
      type: 'offline',
      // This endpoint leaves device-mode tasks pending for an external callback.
      task_type: 'task',
      git_url: '',
      git_repo: '',
      git_repo_id: 0,
      git_domain: '',
      branch_name: '',
      auto_delete_executor: 'false',
      source: 'web',
    })
    expect(createTaskResponse.status).toBe(201)

    const taskDetailResponse = await apiClient.get<TaskDetailResponse>(`/api/tasks/${taskId}`)
    expect(taskDetailResponse.status).toBe(200)

    const subtasks = taskDetailResponse.data?.subtasks ?? []
    const assistantSubtask = subtasks.find(subtask => String(subtask.role) === 'ASSISTANT')
    expect(assistantSubtask?.status).toBe('PENDING')

    const callbackResponse = await apiClient.post('/api/internal/callback', {
      event_type: 'error',
      task_id: taskId,
      subtask_id: assistantSubtask?.id,
      executor_name: `executor-${taskId}`,
      executor_namespace: 'default',
      data: {
        message: 'force unavailable state for e2e',
      },
    })
    expect(callbackResponse.status).toBe(200)

    const statusResponse = await apiClient.get<RemoteWorkspaceStatusResponse>(
      `/api/tasks/${taskId}/remote-workspace/status`
    )
    expect(statusResponse.status).toBe(200)
    expect(statusResponse.data?.connected).toBe(true)
    expect(statusResponse.data?.available).toBe(false)
    // root_path is task-scoped: /workspace/{task_id} when sandbox is unavailable
    expect(statusResponse.data?.root_path).toBe(`/workspace/${taskId}`)

    await page.goto(`/chat?taskId=${taskId}`, {
      waitUntil: 'domcontentloaded',
    })
    const remoteWorkspaceButton = page.getByTestId('remote-workspace-button')
    await expect(remoteWorkspaceButton).toBeVisible({ timeout: 20000 })
    await expect(remoteWorkspaceButton).toHaveAttribute(
      'title',
      /Remote sandbox is not running|远程沙箱未运行/
    )
    await expect(remoteWorkspaceButton).toBeDisabled()
  })

  test('remote workspace tree endpoint rejects parent-escape path', async () => {
    const response = await apiClient.get(
      '/api/tasks/1/remote-workspace/tree?path=%2Fworkspace%2F..%2Fetc'
    )

    expect(response.status).toBe(400)
  })
})
