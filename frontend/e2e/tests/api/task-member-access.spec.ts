import { execFileSync } from 'child_process'
import { resolve } from 'path'

import { expect, test } from '@playwright/test'

import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { ApiClient, createApiClient } from '../../utils/api-client'

type TeamItem = {
  id: number
  bots: Array<{ bot_id: number }>
}

type TeamListResponse = {
  items: TeamItem[]
}

type CurrentUserResponse = {
  id: number
  user_name: string
}

type TaskDetailResponse = {
  id: number
  title: string
  prompt: string
  task_type: string
  is_group_chat: boolean
  is_group_owner: boolean
  member_count: number | null
  subtasks: Array<{ id: number }>
}

type RemoteWorkspaceStatusResponse = {
  connected: boolean
  available: boolean
  root_path: string
  reason: string | null
}

type MemberState = 'absent' | 'pending' | 'approved' | 'rejected' | 'copied'

type MemberFixture = {
  taskId: number
  ownerUsername: string
  memberUserId: number
  memberUsername: string
}

function setTaskMemberState(fixture: MemberFixture, state: MemberState): void {
  if (!process.env.DATABASE_URL) {
    throw new Error('Task member E2E requires an explicit isolated DATABASE_URL')
  }

  const result = JSON.parse(
    execFileSync('uv', ['run', 'python', '-m', 'tests.e2e_set_task_member_state'], {
      cwd: resolve(process.cwd(), '../backend'),
      encoding: 'utf8',
      timeout: 30_000,
      input: JSON.stringify({
        state,
        task_id: fixture.taskId,
        owner_username: fixture.ownerUsername,
        member_user_id: fixture.memberUserId,
        member_username: fixture.memberUsername,
      }),
    })
  ) as { state: MemberState; task_id: number }

  expect(result).toEqual({ state, task_id: fixture.taskId })
}

async function expectTaskHidden(api: ApiClient, taskId: number): Promise<void> {
  const detail = await api.get(`/api/tasks/${taskId}`)
  expect(detail.status).toBe(404)

  const workspaceStatus = await api.get(`/api/tasks/${taskId}/remote-workspace/status`)
  expect(workspaceStatus.status).toBe(404)
}

test.describe('Task member access through Rust routes', () => {
  let ownerApi: ApiClient
  let memberApi: ApiClient
  let createdTaskId: number | null = null
  let memberFixture: MemberFixture | null = null

  test.beforeEach(async ({ request }) => {
    ownerApi = createApiClient(request)
    memberApi = createApiClient(request)

    expect((await ownerApi.login(ADMIN_USER.username, ADMIN_USER.password)).status).toBe(200)
    expect((await memberApi.login(REGULAR_USER.username, REGULAR_USER.password)).status).toBe(200)
  })

  test.afterEach(async () => {
    if (memberFixture) {
      setTaskMemberState(memberFixture, 'absent')
      memberFixture = null
    }
    if (createdTaskId !== null) {
      await ownerApi.deleteTask(String(createdTaskId))
      createdTaskId = null
    }
  })

  test('enforces approved membership for task detail and remote workspace status', async () => {
    const ownerResponse = await ownerApi.get<CurrentUserResponse>('/api/users/me')
    const memberResponse = await memberApi.get<CurrentUserResponse>('/api/users/me')
    expect(ownerResponse.status).toBe(200)
    expect(memberResponse.status).toBe(200)
    expect(ownerResponse.data).toBeTruthy()
    expect(memberResponse.data).toBeTruthy()

    const teamsResponse = await ownerApi.get<TeamListResponse>(
      '/api/teams?page=1&limit=100&scope=all'
    )
    expect(teamsResponse.status).toBe(200)
    const team = teamsResponse.data?.items.find(item => item.bots.length > 0)
    expect(team).toBeTruthy()

    const reserved = await ownerApi.post<{ task_id: number }>('/api/tasks')
    expect(reserved.status).toBe(200)
    expect(reserved.data?.task_id).toEqual(expect.any(Number))
    const taskId = reserved.data!.task_id
    createdTaskId = taskId

    const prompt = `e2e approved task member access ${taskId}`
    const created = await ownerApi.post(`/api/tasks/${taskId}`, {
      prompt,
      team_id: team!.id,
      type: 'offline',
      task_type: 'code',
      git_url: '',
      git_repo: '',
      git_repo_id: 0,
      git_domain: '',
      branch_name: '',
      auto_delete_executor: 'false',
      source: 'web',
    })
    expect(created.status).toBe(201)

    const converted = await ownerApi.post(`/api/tasks/${taskId}/convert-to-group-chat`)
    expect(converted.status).toBe(200)

    memberFixture = {
      taskId,
      ownerUsername: ownerResponse.data!.user_name,
      memberUserId: memberResponse.data!.id,
      memberUsername: memberResponse.data!.user_name,
    }
    setTaskMemberState(memberFixture, 'absent')

    const ownerDetail = await ownerApi.get<TaskDetailResponse>(`/api/tasks/${taskId}`)
    expect(ownerDetail.status).toBe(200)
    expect(ownerDetail.data).toMatchObject({
      id: taskId,
      prompt,
      task_type: 'code',
      is_group_chat: true,
      is_group_owner: true,
      member_count: 0,
    })

    const ownerWorkspace = await ownerApi.get<RemoteWorkspaceStatusResponse>(
      `/api/tasks/${taskId}/remote-workspace/status`
    )
    expect(ownerWorkspace.status).toBe(200)
    expect(ownerWorkspace.data).toMatchObject({
      connected: expect.any(Boolean),
      available: expect.any(Boolean),
      root_path: expect.any(String),
    })
    expect(
      ownerWorkspace.data?.reason === null || typeof ownerWorkspace.data?.reason === 'string'
    ).toBe(true)

    await expectTaskHidden(memberApi, taskId)

    setTaskMemberState(memberFixture, 'pending')
    await expectTaskHidden(memberApi, taskId)

    setTaskMemberState(memberFixture, 'approved')
    const memberDetail = await memberApi.get<TaskDetailResponse>(`/api/tasks/${taskId}`)
    expect(memberDetail.status).toBe(200)
    expect(memberDetail.data).toMatchObject({
      id: taskId,
      title: ownerDetail.data?.title,
      prompt,
      task_type: 'code',
      is_group_chat: true,
      is_group_owner: false,
      member_count: 1,
    })
    expect(memberDetail.data?.subtasks.map(subtask => subtask.id)).toEqual(
      ownerDetail.data?.subtasks.map(subtask => subtask.id)
    )

    const memberWorkspace = await memberApi.get<RemoteWorkspaceStatusResponse>(
      `/api/tasks/${taskId}/remote-workspace/status`
    )
    expect(memberWorkspace.status).toBe(200)
    expect(memberWorkspace.data).toEqual(ownerWorkspace.data)

    setTaskMemberState(memberFixture, 'rejected')
    await expectTaskHidden(memberApi, taskId)

    setTaskMemberState(memberFixture, 'copied')
    await expectTaskHidden(memberApi, taskId)
  })
})
