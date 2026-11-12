import type { APIRequestContext, APIResponse } from '@playwright/test'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { EXECUTOR_USER, executorMockUrl, expect, test } from '../../fixtures/executor-test'
import { createBackendRequestHeaders } from '../../utils/api-client'
import { type Roots, type Runtime, runtimeProcess } from '../../utils/pipeline-archive-runtime'

const API = process.env.E2E_API_URL || 'http://localhost:8000'
const MANAGER = `${process.env.EXECUTOR_MANAGER_URL || 'http://localhost:8001'}/executor-manager`
const IMAGE = process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'

const CLAUDE_SESSION = `
const fs = require('node:fs')
const path = require('node:path')
const { roots, taskId, user, team } = JSON.parse(process.argv[1])
const markerDir = path.join(roots.executor_home, 'sessions', String(taskId))
const markers = fs.readdirSync(markerDir)
  .filter(name => name === '.claude_session_id' || name.startsWith('.claude_session_id_'))
if (markers.length !== 1) throw Error('Expected one Claude session marker, got ' + markers.length)
const id = fs.readFileSync(path.join(markerDir, markers[0]), 'utf8').trim()
if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('Invalid Claude session ID')
const projects = path.join(roots.workbench_home, 'agents', user, 'default', team, 'projects')
const transcripts = fs.readdirSync(projects, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => path.join(projects, entry.name, id + '.jsonl'))
  .filter(file => fs.existsSync(file))
if (transcripts.length !== 1) throw Error('Expected one native transcript for session ' + id)
console.log(JSON.stringify({ id, transcript: fs.readFileSync(transcripts[0], 'utf8') }))
`

const WORKSPACE_FILE = `
const fs = require('node:fs')
const path = require('node:path')
const { workspace, contents } = JSON.parse(process.argv[1])
const file = path.join(workspace, 'executor-recovery.txt')
if (contents === undefined) console.log(JSON.stringify(fs.readFileSync(file, 'utf8')))
else fs.writeFileSync(file, contents)
`

type ExecutorBinding = Pick<TaskDetailSubtask, 'executor_name' | 'executor_namespace'>
type ExecutorAddress =
  | { status: 'success'; base_url: string }
  | { status: 'failed'; error_msg: string }
type TaskWithSubtasks = TaskDetail & { subtasks: TaskDetailSubtask[] }
type ClaudeSession = { id: string; transcript: string }

test('Responses continues a ClaudeCode session on a replacement executor after workspace cleanup', async ({
  request,
  executorAccount,
}) => {
  test.setTimeout(180_000)
  const prefix = `e2e-recovery-${Date.now()}`
  const seed = `SEED_${prefix}`
  const continuation = `CONTINUE_RECOVERED_SESSION_${prefix}`
  const firstReply = `SEED_OK_${prefix}`
  const secondReply = `RECOVERY_OK_${prefix}`
  const headers = createBackendRequestHeaders(executorAccount.token)
  const model = `${prefix}-model`
  const shell = `${prefix}-shell`
  const bot = `${prefix}-bot`
  const team = `${prefix}-team`
  const kinds = `${API}/api/v1/namespaces/default`
  const cleanup: string[] = []
  const post = <T>(url: string, data: object) => json<T>(request.post(url, { headers, data }))
  const createResponse = (input: string, previous_response_id?: string) =>
    json<{ id: string; status: string }>(
      request.post(`${API}/api/v1/responses`, {
        headers: { ...headers, 'auto-delete-executor': 'false' },
        data: { model: `default#${team}`, input, previous_response_id, stream: false },
      })
    )

  try {
    const provider = executorMockUrl(process.env.E2E_CLAUDE_MODEL_SERVER_URL)
    await post(`${kinds}/models`, {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: { name: model, namespace: 'default' },
      spec: {
        modelConfig: {
          env: {
            model: 'claude',
            model_id: 'claude-3-5-sonnet-20241022',
            api_key: 'mock-api-key',
            base_url: `${provider}/v1`,
          },
        },
      },
    })
    cleanup.push(`${kinds}/models/${model}`)
    await post(`${API}/api/shells`, {
      name: shell,
      displayName: shell,
      baseShellRef: 'ClaudeCode',
      baseImage: IMAGE,
    })
    cleanup.push(`${API}/api/shells/${shell}`)
    const { id: botId } = await post<{ id: number }>(`${API}/api/bots`, {
      name: bot,
      shell_name: shell,
      agent_config: { bind_model: model, bind_model_type: 'user' },
      system_prompt: 'Respond directly without using tools.',
      inherit_base_capabilities: false,
      namespace: 'default',
      is_active: true,
    })
    cleanup.push(`${kinds}/bots/${bot}`)
    await post(`${API}/api/teams`, {
      name: team,
      namespace: 'default',
      is_active: true,
      requires_workspace: false,
      bind_mode: ['chat'],
      bots: [{ bot_id: botId, bot_prompt: '', role: 'leader' }],
      workflow: { mode: 'solo', leader_bot_id: botId },
    })
    cleanup.push(`${kinds}/teams/${team}`)
    for (const [matchText, responseContent] of [
      [seed, firstReply],
      [continuation, secondReply],
    ]) {
      await json(
        request.post(`${executorMockUrl()}/stream-rules`, {
          data: { matchText, responseContent, chunkDelayMs: 0 },
        })
      )
    }

    const initial = await createResponse(seed)
    expect(initial.id).toMatch(/^resp_\d+$/)
    const taskId = Number(initial.id.slice('resp_'.length))
    const taskUrl = `${API}/api/tasks/${taskId}`
    cleanup.push(taskUrl)
    expect(initial.status).toBe('queued')
    const first = await completedAssistant(request, taskUrl, headers, firstReply)
    const original = await runtimeFor(request, first)
    const rootsFor = (runtime: Runtime) =>
      json<Roots>(
        request.post(`${runtime.base_url}/api/runtime/prepare`, { data: { task_id: taskId } })
      )
    const readSession = (runtime: Runtime, roots: Roots) =>
      runtimeProcess<ClaudeSession>(request, runtime, CLAUDE_SESSION, {
        roots,
        taskId,
        user: EXECUTOR_USER.username,
        team,
      })

    const originalRoots = await rootsFor(original)
    const before = await readSession(original, originalRoots)
    expect(before.transcript).toContain(firstReply)
    await runtimeProcess(request, original, WORKSPACE_FILE, {
      workspace: originalRoots.workspace_path,
      contents: prefix,
    })

    // Production cleanup archives the workspace, deletes the container and marks its binding deleted.
    const cleaned = await post(`${taskUrl}/cleanup-executor`, {})
    expect(cleaned).toMatchObject({
      deleted: true,
      executors: [
        { executor_name: first.executor_name, executor_namespace: first.executor_namespace },
      ],
    })
    expect(await addressFor(request, first)).toMatchObject({
      status: 'failed',
      error_msg: expect.stringContaining('not found'),
    })

    const resumed = await createResponse(continuation, initial.id)
    expect(resumed).toMatchObject({ id: initial.id, status: 'queued' })
    const second = await completedAssistant(request, taskUrl, headers, secondReply, first.id)
    expect(second.executor_name).toBeTruthy()
    expect(second.executor_name).not.toBe(first.executor_name)
    const replacement = await runtimeFor(request, second)
    const restoredRoots = await rootsFor(replacement)
    const after = await readSession(replacement, restoredRoots)
    expect(after.id).toBe(before.id)
    expect(after.transcript).toContain(firstReply)
    expect(after.transcript).toContain(secondReply)
    const restoredFile = await runtimeProcess<string>(request, replacement, WORKSPACE_FILE, {
      workspace: restoredRoots.workspace_path,
    })
    expect(restoredFile).toBe(prefix)
  } finally {
    const failures: string[] = []
    for (const url of cleanup.reverse()) {
      const response = await request.delete(url, { headers })
      if (!response.ok()) failures.push(`${url}: ${response.status()} ${await response.text()}`)
      await response.dispose()
    }
    expect(failures).toEqual([])
  }
})

async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  const response = await pending
  try {
    expect(response.ok(), `${response.status()} ${response.url()}: ${await response.text()}`).toBe(
      true
    )
    return (await response.json()) as T
  } finally {
    await response.dispose()
  }
}

async function addressFor(request: APIRequestContext, executor: ExecutorBinding) {
  const { executor_name, executor_namespace } = executor
  return json<ExecutorAddress>(
    request.get(`${MANAGER}/executor/address`, {
      params: { executor_name, executor_namespace },
    })
  )
}

async function runtimeFor(request: APIRequestContext, executor: ExecutorBinding): Promise<Runtime> {
  const address = await addressFor(request, executor)
  if (address.status !== 'success') throw new Error(address.error_msg)
  return {
    base_url: address.base_url,
    container_name: executor.executor_name,
    executor_namespace: executor.executor_namespace,
  }
}

async function completedAssistant(
  request: APIRequestContext,
  taskUrl: string,
  headers: Record<string, string>,
  reply: string,
  previousId?: number
): Promise<TaskDetailSubtask> {
  let assistant: TaskDetailSubtask | undefined
  await expect
    .poll(
      async () => {
        const task = await json<TaskWithSubtasks>(request.get(taskUrl, { headers }))
        expect(['FAILED', 'CANCELLED'], task.error_message).not.toContain(task.status)
        assistant = task.subtasks.find(
          subtask => subtask.role === 'ASSISTANT' && subtask.id !== previousId
        )
        return task.status === 'COMPLETED' ? assistant?.status : task.status
      },
      { timeout: 65_000 }
    )
    .toBe('COMPLETED')
  expect(assistant?.result.value).toBe(reply)
  return assistant!
}
