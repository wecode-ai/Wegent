import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ADMIN_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

type TreeEntry = {
  name: string
  path: string
  is_directory: boolean
  size: number
}

type TreeResponse = { path: string; entries: TreeEntry[] }
type WorkspaceStatus = {
  connected: boolean
  available: boolean
  root_path: string
  reason: string | null
}

const managerUrl = process.env.E2E_EXECUTOR_MANAGER_URL || 'http://localhost:8001'
const executorImage =
  process.env.E2E_REMOTE_WORKSPACE_EXECUTOR_IMAGE || 'wegent/e2e-workspace-executor:latest'
const deepContent = 'physical workspace second-level file\n'
const outsideContent = 'outside-workspace-must-not-leak'

test('Rust workspace API browses a real Executor repository using returned physical paths', async ({
  request,
}, testInfo) => {
  test.setTimeout(120_000)
  const api = createApiClient(request)
  const login = await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  expect(login.status).toBe(200)
  let taskId: number | undefined
  let executorName: string | undefined

  try {
    const teams = await api.get<{ items: Array<{ id: number; bots: unknown[] }> }>(
      '/api/teams?page=1&limit=100&scope=all'
    )
    expect(teams.status).toBe(200)
    const team = teams.data?.items.find(item => item.bots.length > 0)
    expect(team).toBeTruthy()
    const reserved = await api.post<{ task_id: number }>('/api/tasks')
    expect(reserved.status).toBe(200)
    taskId = reserved.data!.task_id
    const created = await api.post(`/api/tasks/${taskId}`, {
      prompt: 'physical remote workspace E2E',
      team_id: team!.id,
      type: 'offline',
      task_type: 'code',
      auto_delete_executor: 'false',
      source: 'web',
    })
    expect(created.status).toBe(201)
    const detail = await api.get<{ subtasks: Array<{ id: number; role: string }> }>(
      `/api/tasks/${taskId}`
    )
    expect(detail.status).toBe(200)
    const assistant = detail.data!.subtasks.find(subtask => subtask.role === 'ASSISTANT')
    expect(assistant).toBeTruthy()

    // Provision the production Docker executor without invoking an agent or a model.
    const prepared = await request.post(`${managerUrl}/executor-manager/executors/prepare`, {
      data: {
        task_id: taskId,
        subtask_id: assistant!.id,
        user: { name: ADMIN_USER.username },
        executor_type: 'docker',
        executor_image: executorImage,
      },
      timeout: 60_000,
    })
    expect(prepared.status(), await prepared.text()).toBe(200)
    const runtime = (await prepared.json()) as {
      status: string
      executor_name: string
      executor_namespace: string
    }
    executorName = runtime.executor_name
    expect(runtime.status).toBe('success')
    expect(executorName).toBeTruthy()
    const addressResponse = await request.get(`${managerUrl}/executor-manager/executor/address`, {
      params: { executor_name: executorName! },
    })
    expect(addressResponse.status()).toBe(200)
    const address = (await addressResponse.json()) as { status: string; base_url: string }
    expect(address.status).toBe('success')
    const executorUrl = address.base_url
    const workspace = await request.post(`${executorUrl}/api/runtime/prepare`, {
      data: { task_id: taskId },
    })
    expect(workspace.status()).toBe(200)
    const { workspace_path: physicalRoot } = (await workspace.json()) as {
      workspace_path: string
    }
    expect(physicalRoot).not.toBe(`/workspace/${taskId}`)

    // Create a real Git repository through the Executor's process API.
    const outsideRoot = `${physicalRoot}-outside`
    const seeded = await request.post(`${executorUrl}/process.Process/Start`, {
      headers: { 'Connect-Protocol-Version': '1' },
      data: {
        process: {
          cmd: 'sh',
          args: [
            '-ec',
            'git init --initial-branch=main .\n' +
              'mkdir -p level-one/level-two\n' +
              'printf "root file\\n" > ROOT.txt\n' +
              'printf "first level\\n" > level-one/first.txt\n' +
              'printf "%s" "$DEEP_CONTENT" > level-one/level-two/deep.txt\n' +
              'git add .\n' +
              'git -c user.name="Workspace E2E" -c user.email=workspace@example.test commit -m fixture\n' +
              'mkdir -p "$OUTSIDE_ROOT"\n' +
              'printf "%s" "$OUTSIDE_CONTENT" > "$OUTSIDE_ROOT/secret.txt"',
          ],
          cwd: physicalRoot,
          envs: {
            DEEP_CONTENT: deepContent,
            OUTSIDE_ROOT: outsideRoot,
            OUTSIDE_CONTENT: outsideContent,
          },
        },
      },
    })
    expect(seeded.status()).toBe(200)
    const processEvents = parseConnectMessages(await seeded.body())
    expect(processEvents).toContainEqual({
      event: { end: { exitCode: 0, exited: true, status: 'success', error: '' } },
    })

    // Bind the prepared runtime through the real Manager-to-Backend callback path.
    const binding = await request.post(`${managerUrl}/executor-manager/callback`, {
      data: {
        event_type: 'response.completed',
        task_id: taskId,
        subtask_id: assistant!.id,
        executor_name: executorName,
        executor_namespace: runtime.executor_namespace,
        data: { response: { output: [] } },
      },
    })
    expect(binding.status(), await binding.text()).toBe(200)

    const taskPath = `/api/tasks/${taskId}/remote-workspace`
    const status = await api.get<WorkspaceStatus>(`${taskPath}/status`)
    expect(status.status).toBe(200)
    expect(status.data).toEqual({
      connected: true,
      available: true,
      root_path: physicalRoot,
      reason: null,
    })
    const tree = await api.get<TreeResponse>(`${taskPath}/tree`)
    expect(tree.status).toBe(200)
    expect(tree.data!.path).toBe(physicalRoot)
    expect(tree.data!.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '.git', is_directory: true }),
        expect.objectContaining({ name: 'ROOT.txt', path: `${physicalRoot}/ROOT.txt` }),
      ])
    )
    const first = tree.data!.entries.find(entry => entry.name === 'level-one')!
    expect(first).toMatchObject({ path: `${physicalRoot}/level-one`, is_directory: true })
    const firstTree = await api.get<TreeResponse>(
      `${taskPath}/tree?path=${encodeURIComponent(first.path)}`
    )
    expect(firstTree.status).toBe(200)
    expect(firstTree.data!.path).toBe(first.path)
    expect(firstTree.data!.entries.map(entry => entry.name).sort()).toEqual([
      'first.txt',
      'level-two',
    ])
    const second = firstTree.data!.entries.find(entry => entry.name === 'level-two')!
    expect(second).toMatchObject({ path: `${first.path}/level-two`, is_directory: true })
    const secondTree = await api.get<TreeResponse>(
      `${taskPath}/tree?path=${encodeURIComponent(second.path)}`
    )
    expect(secondTree.status).toBe(200)
    expect(secondTree.data).toEqual({
      path: second.path,
      entries: [
        expect.objectContaining({
          name: 'deep.txt',
          path: `${second.path}/deep.txt`,
          is_directory: false,
          size: Buffer.byteLength(deepContent),
        }),
      ],
    })
    const file = await request.get(`${executorUrl}/filesystem/file`, {
      params: { path: secondTree.data!.entries[0].path },
    })
    expect(file.status()).toBe(200)
    expect(await file.text()).toBe(deepContent)
    const outsideFile = await request.get(`${executorUrl}/filesystem/file`, {
      params: { path: `${outsideRoot}/secret.txt` },
    })
    expect(outsideFile.status()).toBe(200)
    expect(await outsideFile.text()).toBe(outsideContent)

    for (const [path, detailMessage] of [
      [outsideRoot, `Path must stay within ${physicalRoot}`],
      [`${physicalRoot}/../${taskId}-outside`, 'Parent traversal is not allowed'],
      [`${first.path}/../ROOT.txt`, 'Parent traversal is not allowed'],
    ]) {
      const denied = await api.get(`${taskPath}/tree?path=${encodeURIComponent(path)}`)
      expect(denied.status).toBe(400)
      expect(denied.data).toEqual({ detail: detailMessage })
      expect(JSON.stringify(denied.data)).not.toContain(outsideContent)
    }

    // Rust handler access logs establish ownership; Python fallback must not serve these calls.
    const rustLogRoot = resolve(__dirname, '../../../../logs/backend/rust')
    await expect
      .poll(() => readFile(resolve(rustLogRoot, 'api.log'), 'utf8'))
      .toContain(`GET ${taskPath}/status 200`)
    const rustApiLog = await readFile(resolve(rustLogRoot, 'api.log'), 'utf8')
    expect(rustApiLog).toContain(`GET ${taskPath}/tree 200`)
    const fallbackLog = await readFile(resolve(rustLogRoot, 'fallback.log'), 'utf8')
    expect(fallbackLog).not.toContain(`${taskPath}/status`)
    expect(fallbackLog).not.toContain(`${taskPath}/tree`)
    await testInfo.attach('physical-workspace-paths', {
      body: JSON.stringify({ taskId, executorName, physicalRoot, first, second, secondTree }),
      contentType: 'application/json',
    })
  } finally {
    if (executorName) {
      const deleted = await request.post(`${managerUrl}/executor-manager/executor/delete`, {
        data: { executor_name: executorName },
      })
      expect(deleted.status(), await deleted.text()).toBe(200)
      expect((await deleted.json()).status).toBe('success')
    }
    if (taskId) expect((await api.deleteTask(String(taskId))).status).toBe(200)
  }
})

function parseConnectMessages(body: Buffer): unknown[] {
  const messages: unknown[] = []
  for (let offset = 0; offset < body.length; ) {
    const flags = body[offset]
    const length = body.readUInt32BE(offset + 1)
    const message = body.subarray(offset + 5, offset + 5 + length)
    if (flags === 0) messages.push(JSON.parse(message.toString('utf8')))
    offset += 5 + length
  }
  return messages
}
