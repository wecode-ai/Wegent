import { readFile } from 'node:fs/promises'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { EXECUTOR_USER, executorMockUrl, expect, test } from '../../fixtures/executor-test'
import { createBackendRequestHeaders } from '../../utils/api-client'
import { type Roots, type Runtime, runtimeProcess } from '../../utils/pipeline-archive-runtime'

const API = process.env.E2E_API_URL || 'http://localhost:8000'
const MANAGER = `${process.env.EXECUTOR_MANAGER_URL || 'http://localhost:8001'}/executor-manager`
const IMAGE = process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const RECOVERY = process.env.E2E_EXECUTOR_RECOVERY_URL || 'http://localhost:8191'
const GATEWAY_LOG = process.env.E2E_EXECUTOR_RECOVERY_GATEWAY_LOG || '../logs/backend/rust/info.log'

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
type RecoveryMode = 'prepare' | 'restore' | 'cancel' | 'binding'
type ManagerResponse = { status: number; body: { detail?: string; success?: boolean } }
type RecoveryState = {
  prepare?: (ManagerResponse & { body: ExecutorBinding }) | null
  restore?: ManagerResponse | null
  delete?: (ManagerResponse & { body: { status: string } }) | null
}
type SocketTerminal = { task_id: number; subtask_id?: number; status?: string; type?: string }

test('Responses recovers a ClaudeCode executor and closes failed or cancelled recovery turns', async ({
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

    const archive = async (binding: ExecutorBinding) => {
      const { executor_name, executor_namespace } = binding
      expect(await post(`${taskUrl}/cleanup-executor`, {})).toMatchObject({
        deleted: true,
        executors: [{ executor_name, executor_namespace }],
      })
      expect(await addressFor(request, binding)).toMatchObject({
        status: 'failed',
        error_msg: expect.stringContaining('not found'),
      })
    }
    await archive(first)

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

    await archive(second)
    let prior = second
    for (const mode of ['prepare', 'binding', 'restore', 'cancel'] as const) {
      await test.step(`recovery ${mode}`, async () => {
        prior = await exerciseRecoveryFailure({
          mode,
          request,
          token: executorAccount.token,
          responseId: initial.id,
          model: `default#${team}`,
          shell,
          prior,
        })
      })
    }
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

async function exerciseRecoveryFailure({
  mode,
  request,
  token,
  responseId,
  model,
  shell,
  prior,
}: {
  mode: RecoveryMode
  request: APIRequestContext
  token: string
  responseId: string
  model: string
  shell: string
  prior: TaskDetailSubtask
}): Promise<TaskDetailSubtask> {
  const taskId = prior.task_id
  const headers = createBackendRequestHeaders(token)
  const fixture = `${RECOVERY}/fixture/${taskId}`
  const fixtureToken = process.env.E2E_INTERNAL_SERVICE_TOKEN || process.env.INTERNAL_SERVICE_TOKEN
  expect(fixtureToken, 'Executor recovery fixture token').toBeTruthy()
  const fixtureHeaders = createBackendRequestHeaders(fixtureToken)
  const socket = createAuthenticatedSocketClient({
    socketBaseUrl: () => API,
    getToken: () => token,
    namespace: '/chat',
  })
  const errors: SocketTerminal[] = []
  const cancellations: SocketTerminal[] = []
  const statuses: SocketTerminal[] = []
  const controller = new AbortController()
  const detail = () =>
    json<TaskWithSubtasks>(request.get(`${API}/api/tasks/${taskId}`, { headers }))
  const inspect = () => json<RecoveryState>(request.get(fixture, { headers: fixtureHeaders }))
  const shellUrl = `${API}/api/shells/${shell}`
  const release = () => json(request.post(`${fixture}/release`, { headers: fixtureHeaders }))
  const held = mode === 'cancel' || mode === 'binding'
  let armed = false
  let cancelledSubtaskId: number | undefined
  try {
    await socket.ensureConnected()
    const raw = socket.getRawSocket()!
    raw.on('chat:error', event => errors.push(event))
    raw.on('chat:cancelled', event => cancellations.push(event))
    raw.on('task:status', event => statuses.push(event))
    const joined = await raw.timeout(10_000).emitWithAck('task:join', { task_id: taskId })
    expect(joined.error).toBeUndefined()
    await json(request.put(`${fixture}/${mode}`, { headers: fixtureHeaders }))
    armed = true
    if (mode === 'prepare') {
      await json(
        request.put(shellUrl, {
          headers,
          data: { baseImage: '127.0.0.1:1/wegent/recovery-missing:latest' },
        })
      )
    }

    const response = await fetch(`${API}/api/v1/responses`, {
      method: 'POST',
      headers: { ...headers, 'auto-delete-executor': 'false' },
      body: JSON.stringify({
        model,
        input: `Recovery ${mode} must not reach the model`,
        previous_response_id: responseId,
        stream: true,
      }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]),
    })
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    if (held) {
      await expect
        .poll(async () => (await inspect()).restore?.status, { timeout: 45_000 })
        .toBe(mode === 'binding' ? 200 : 500)
      const pending = latestAssistant(await detail())
      expect(pending.id).not.toBe(prior.id)
      expect(pending.status).toBe('PENDING')
      if (mode === 'binding') {
        await json(
          request.post(`${fixture}/change-binding/${pending.id}`, { headers: fixtureHeaders })
        )
      } else {
        cancelledSubtaskId = pending.id
        expect(
          await raw.timeout(10_000).emitWithAck('chat:cancel', {
            subtask_id: pending.id,
            shell_type: 'ClaudeCode',
          })
        ).toMatchObject({ success: true, finalized: true })
      }
      await release()
    }

    const stream = await response.text()
    const terminal = mode === 'cancel' ? 'CANCELLED' : 'FAILED'
    const type = mode === 'cancel' ? 'response.completed' : 'response.failed'
    const terminalTypes = stream
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)).type)
      .filter(event =>
        ['response.completed', 'response.failed', 'response.incomplete'].includes(event)
      )
    expect(terminalTypes).toEqual([type])
    if (mode === 'binding') expect(stream).toContain('Executor binding changed during recovery')
    if (mode === 'restore') expect(stream).toContain('was not restored')
    await expect
      .poll(async () => (await inspect()).prepare?.status)
      .toBe(mode === 'prepare' ? 500 : 200)
    if (mode === 'prepare') {
      expect((await inspect()).prepare?.body.detail).toContain(
        '127.0.0.1:1/wegent/recovery-missing'
      )
      expect((await inspect()).restore).toBeNull()
    } else {
      const { prepare, restore } = await inspect()
      expect(prepare?.body.executor_name).toBeTruthy()
      expect(prepare?.body.executor_name).not.toBe(prior.executor_name)
      expect(restore?.status).toBe(mode === 'binding' ? 200 : 500)
      await expect.poll(async () => (await inspect()).delete?.body.status).toBe('success')
    }
    await expect
      .poll(() =>
        json<{ names: string[] }>(request.get(`${fixture}/containers`, { headers: fixtureHeaders }))
      )
      .toEqual({ names: [] })
    if (mode === 'cancel') {
      await expect
        .poll(async () => {
          const log = await readFile(GATEWAY_LOG, 'utf8')
          return log
            .split('\n')
            .some(
              line =>
                line.includes('executor recovery failure handled') &&
                line.includes(`task_id=${taskId}`) &&
                line.includes(`subtask_id=${cancelledSubtaskId}`)
            )
        })
        .toBe(true)
    }
    const task = await detail()
    const assistant = latestAssistant(task)
    expect(assistant.id).not.toBe(prior.id)
    expect(assistant.executor_name).toBe(prior.executor_name)
    expect(task.status).toBe(terminal)
    expect(assistant.status).toBe(terminal)
    await expect
      .poll(() => statuses.filter(event => event.task_id === taskId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: terminal })]))
    if (mode === 'cancel') {
      expect(assistant.error_message || '').toBe('')
      expect(assistant.result.error_type).toBeUndefined()
      expect(errors).toEqual([])
      expect(statuses.filter(event => event.status === 'FAILED')).toEqual([])
      expect(cancellations).toEqual([expect.objectContaining({ subtask_id: assistant.id })])
    } else {
      expect(assistant.error_message).toBeTruthy()
      expect(assistant.result.error_type).toBe('container_error')
      expect(errors).toEqual([
        expect.objectContaining({ subtask_id: assistant.id, type: 'container_error' }),
      ])
      expect(cancellations).toEqual([])
    }
    return assistant
  } finally {
    controller.abort()
    socket.dispose()
    if (armed && held) await release()
    if (mode === 'prepare') {
      await json(request.put(shellUrl, { headers, data: { baseImage: IMAGE } }))
    }
  }
}

function latestAssistant(task: TaskWithSubtasks): TaskDetailSubtask {
  const assistant = task.subtasks.filter(item => item.role === 'ASSISTANT').at(-1)
  expect(assistant).toBeDefined()
  return assistant!
}

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
      headers: createBackendRequestHeaders(),
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
