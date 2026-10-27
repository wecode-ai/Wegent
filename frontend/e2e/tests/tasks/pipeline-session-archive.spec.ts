import { APIRequestContext, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { ADMIN_USER } from '../../config/test-users'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'
import {
  Roots,
  Runtime,
  SESSION_FILES,
  Snapshot,
  resolveRuntime,
  runtimeProcess,
} from '../../utils/pipeline-archive-runtime'

const API = process.env.E2E_API_URL || 'http://localhost:8000'
const MANAGER = `${process.env.EXECUTOR_MANAGER_URL || 'http://localhost:8001'}/executor-manager`
const MOCK = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const IMAGE = process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const TIMEOUT = 120_000

// Backend, manager, native CLIs, archive HTTP endpoints and MinIO are real.
// The existing model server is the only mocked service.
test.describe('Pipeline native session archive and continuation', () => {
  test.describe.configure({ mode: 'default', timeout: 240_000 })

  for (const engine of ['ClaudeCode', 'Codex'] as const) {
    for (const mode of ['executor', 'sandbox'] as const) {
      test(`${engine}: ${mode} restores both bots and resumes the native conversation`, async ({
        request,
      }, testInfo) => {
        const prefix = `e2e-archive-${engine.toLowerCase()}-${mode}-${Date.now()}`
        const seed = `ARCHIVE_SEED_${prefix}`
        const followup = `ARCHIVE_RESUME_WITH_NATIVE_HISTORY_${prefix}`
        const cleanup: Array<[string, string]> = []
        const login = await createApiClient(request).login(ADMIN_USER.username, ADMIN_USER.password)
        expect(login.data?.access_token).toBeTruthy()
        const headers = createBackendRequestHeaders(login.data!.access_token)
        const internalToken =
          process.env.E2E_INTERNAL_SERVICE_TOKEN || process.env.INTERNAL_SERVICE_TOKEN
        expect(internalToken, 'The CI internal service token is required').toBeTruthy()
        const internal = { Authorization: `Bearer ${internalToken}` }
        const user = await getJson(request, `${API}/api/users/me`, headers)
        let taskId: number | undefined
        let runtime: Runtime | undefined
        let sandboxCreated = false
        try {
          const model = `${prefix}-model`
          const shell = `${prefix}-shell`
          const team = `${prefix}-team`
          const provider =
            engine === 'ClaudeCode'
              ? process.env.E2E_CLAUDE_MODEL_SERVER_URL || MOCK
              : process.env.E2E_CODEX_MODEL_SERVER_URL || MOCK
          await postJson(
            request,
            `${API}/api/v1/namespaces/default/models`,
            {
              apiVersion: 'agent.wecode.io/v1',
              kind: 'Model',
              metadata: { name: model, namespace: 'default' },
              spec: {
                ...(engine === 'Codex'
                  ? { protocol: 'openai-responses', apiFormat: 'responses' }
                  : {}),
                modelConfig: {
                  env: {
                    model: engine === 'ClaudeCode' ? 'claude' : 'openai',
                    model_id:
                      engine === 'ClaudeCode' ? 'claude-3-5-sonnet-20241022' : 'gpt-5.1-codex',
                    api_key: 'mock-api-key',
                    base_url: `${provider}/v1`,
                  },
                },
              },
            },
            headers
          )
          cleanup.push(['models', model])
          await postJson(
            request,
            `${API}/api/shells`,
            {
              name: shell,
              displayName: shell,
              baseShellRef: engine,
              baseImage: IMAGE,
            },
            headers
          )
          cleanup.push(['shells', shell])
          const botIds: number[] = []
          for (const stage of [1, 2]) {
            const name = `${prefix}-bot-${stage}`
            const bot = await postJson(
              request,
              `${API}/api/bots`,
              {
                name,
                shell_name: shell,
                agent_config: { bind_model: model, bind_model_type: 'user' },
                system_prompt: `You are pipeline stage ${stage}. Return the model response without using tools.`,
                inherit_base_capabilities: false,
                namespace: 'default',
                is_active: true,
              },
              headers
            )
            cleanup.push(['bots', name])
            botIds.push(bot.id)
          }
          const agent = await postJson(
            request,
            `${API}/api/teams`,
            {
              name: team,
              namespace: 'default',
              is_active: true,
              requires_workspace: false,
              bind_mode: ['chat'],
              bots: botIds.map((bot_id, index) => ({
                bot_id,
                bot_prompt: '',
                role: index === 0 ? 'leader' : 'worker',
                requireConfirmation: false,
                contextPassing: 'original_and_previous',
              })),
              workflow: { mode: 'pipeline', leader_bot_id: botIds[0] },
            },
            headers
          )
          cleanup.push(['teams', team])
          await postJson(request, `${MOCK}/stream-rules`, {
            matchText: seed,
            responseContent: `SEED_OK_${prefix}`,
            chunkDelayMs: 0,
          })
          const task = await postJson(
            request,
            `${API}/api/tasks/create`,
            {
              team_id: agent.id,
              prompt: seed,
              task_type: 'chat',
              auto_delete_executor: 'false',
            },
            headers
          )
          taskId = task.id
          expect(taskId).toBeGreaterThan(0)
          await expect
            .poll(
              async () => {
                const stage = await getJson(
                  request,
                  `${API}/api/tasks/${taskId}/pipeline-stage-info`,
                  headers
                )
                return stage.current_stage
              },
              { timeout: TIMEOUT }
            )
            .toBe(1)
          await completed(request, taskId!, headers)
          runtime = await resolveRuntime(request, MANAGER, taskId!, headers, 'executor')
          const roots = (await postJson(request, `${runtime.base_url}/api/runtime/prepare`, {
            task_id: taskId,
          })) as Roots
          const params = { roots, taskId, user: user.user_name, team, botIds, engine, mode }
          const snapshot = () =>
            runtimeProcess<Snapshot>(request, runtime!, SESSION_FILES, {
              ...params,
              action: 'snapshot',
            })
          const before = await snapshot()
          expect(Object.keys(before.markers)).toHaveLength(2)
          for (const home of before.homes) {
            expect(before.transcripts.some(file => file.startsWith(`${home}/`))).toBe(true)
          }
          await runtimeProcess(request, runtime, SESSION_FILES, { ...params, action: 'seed' })
          const archiveUrl = `${API}/api/internal/workspace-archives/${taskId}/${mode === 'sandbox' ? 'archive-sandbox' : 'archive'}`
          const archiveBody =
            mode === 'sandbox'
              ? {
                  executor_name: runtime.container_name,
                  executor_namespace: runtime.executor_namespace,
                }
              : {}
          const archived = await postJson(request, archiveUrl, archiveBody, internal)
          expect(archived.archive.sessionFileIncluded).toBe(true)
          const download = await getJson(
            request,
            `${API}/api/internal/workspace-archives/${taskId}/download-url`,
            internal
          )
          const stored = await request.get(download.download_url)
          expect(stored.ok(), await stored.text()).toBe(true)
          const archive = await stored.body()
          // Inspect the actual bytes uploaded to MinIO, including file contents.
          const members = execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' })
            .trim()
            .split('\n')
          expect(
            members.filter(name =>
              /agent-homes\/.+\/bots\/.+\/(projects|sessions)\/.+\.jsonl$/.test(name)
            )
          ).toHaveLength(before.transcripts.length)
          expect(
            members.some(name => /auth\.json|other-task|other-session|e2e-other/.test(name))
          ).toBe(false)
          for (const excluded of ['E2E_ARCHIVE_AUTH_SECRET', 'E2E_OTHER_SESSION']) {
            expect(gunzipSync(archive).includes(Buffer.from(excluded))).toBe(false)
          }
          await testInfo.attach('archive-members', {
            body: JSON.stringify(members, null, 2),
            contentType: 'application/json',
          })

          await runtimeProcess(request, runtime, SESSION_FILES, { ...params, action: 'erase' })
          if (mode === 'sandbox') {
            const detail = await getJson(request, `${API}/api/tasks/${taskId}`, headers)
            const subtasks = detail.subtasks as Array<{ id: number; executor_name?: string }>
            const first = subtasks
              .filter(subtask => subtask.executor_name === runtime!.container_name)
              .sort((a, b) => a.id - b.id)[0]
            expect(first, 'The original container creation subtask is required').toBeTruthy()
            const originalName = runtime.container_name
            await postJson(request, `${MANAGER}/executor/delete`, {
              executor_name: originalName,
              executor_namespace: runtime.executor_namespace,
            })
            sandboxCreated = true
            const sandbox = await postJson(request, `${MANAGER}/sandboxes`, {
              shell_type: engine,
              user_id: user.id,
              user_name: user.user_name,
              metadata: { task_id: taskId, subtask_id: first.id },
            })
            // The backend must continue to dispatch into the recreated runtime.
            expect(sandbox.container_name).toBe(originalName)
            runtime = await resolveRuntime(request, MANAGER, taskId!, headers, 'sandbox')
            // SandboxManager restores the archive during real sandbox creation.
            expect(await snapshot()).toEqual(before)
          }
          const restored = await postJson(request, `${runtime.base_url}/api/restore`, {
            task_id: taskId,
            runtime_type: mode,
            download_url: download.download_url,
          })
          expect(restored.session_restored).toBe(true)
          expect(await snapshot()).toEqual(before)
          await runtimeProcess(request, runtime, SESSION_FILES, { ...params, action: 'verify' })
          // Repeating a restore with the same content must preserve native IDs and bytes.
          await postJson(request, `${runtime.base_url}/api/restore`, {
            task_id: taskId,
            runtime_type: mode,
            download_url: download.download_url,
          })
          expect(await snapshot()).toEqual(before)

          await postJson(request, `${MOCK}/stream-rules`, {
            matchText: followup,
            responseContent: `RESUME_OK_${prefix}`,
            chunkDelayMs: 0,
            doneDelayMs: 30_000,
          })
          await postJson(
            request,
            `${API}/api/tasks/${taskId}`,
            {
              team_id: agent.id,
              prompt: followup,
              task_type: 'chat',
              auto_delete_executor: 'false',
            },
            headers
          )
          await expect
            .poll(
              async () => {
                const captures = (await getJson(request, `${MOCK}/captured-requests`)) as Array<{
                  body: unknown
                }>
                return captures.some(
                  capture =>
                    JSON.stringify(capture.body).includes(followup) &&
                    JSON.stringify(capture.body).includes(`SEED_OK_${prefix}`)
                )
              },
              { timeout: TIMEOUT }
            )
            .toBe(true)
          const archiveRequest = {
            task_id: taskId,
            runtime_type: mode,
            upload_url: download.download_url,
          }
          const runningBackup = await request.post(`${runtime.base_url}/api/archive`, {
            data: archiveRequest,
          })
          expect(runningBackup.status()).toBe(500)
          expect((await runningBackup.json()).detail).toContain('Agent is running')
          await completed(request, taskId!, headers)
          const after = await snapshot()
          expect(after.markers).toEqual(before.markers)
          expect(before.transcripts.some(file => after.files[file] !== before.files[file])).toBe(
            true
          )
          expect(
            after.transcripts.some(file =>
              Buffer.from(after.files[file], 'base64').includes(Buffer.from(`RESUME_OK_${prefix}`))
            )
          ).toBe(true)

          // Remove a real transcript, leaving its real marker: no partial upload is allowed.
          const firstId = Object.values(before.markers)[0].trim()
          const primary = before.transcripts.find(file =>
            file.endsWith(engine === 'ClaudeCode' ? `/${firstId}.jsonl` : `-${firstId}.jsonl`)
          )
          expect(primary).toBeTruthy()
          await runtimeProcess(request, runtime, SESSION_FILES, {
            ...params,
            action: 'missing',
            transcript: primary,
          })
          const incomplete = await request.post(`${runtime.base_url}/api/archive`, {
            data: archiveRequest,
          })
          expect(incomplete.status()).toBe(500)
          expect((await incomplete.json()).detail).toContain('incomplete')
          const unchanged = await request.get(download.download_url)
          expect(unchanged.ok()).toBe(true)
          expect(await unchanged.body()).toEqual(archive)
        } finally {
          // Delete only resources created by this scenario, even after assertion failures.
          const failures: string[] = []
          if (sandboxCreated) {
            const deleted = await request.delete(`${MANAGER}/sandboxes/${taskId}`)
            if (![200, 404].includes(deleted.status()))
              failures.push(`sandbox: ${await deleted.text()}`)
          } else if (runtime) {
            const deleted = await request.post(`${MANAGER}/executor/delete`, {
              data: {
                executor_name: runtime.container_name,
                executor_namespace: runtime.executor_namespace,
              },
            })
            if (!deleted.ok()) failures.push(`runtime: ${await deleted.text()}`)
          }
          if (taskId) {
            const deleted = await request.delete(`${API}/api/tasks/${taskId}`, { headers })
            if (!deleted.ok()) failures.push(`task: ${await deleted.text()}`)
          }
          for (const [kind, name] of cleanup.reverse()) {
            const url =
              kind === 'shells'
                ? `${API}/api/shells/${name}`
                : `${API}/api/v1/namespaces/default/${kind}/${name}`
            const deleted = await request.delete(url, { headers })
            if (![200, 204, 404].includes(deleted.status()))
              failures.push(`${kind}: ${await deleted.text()}`)
          }
          for (const matchText of [seed, followup]) {
            const cleared = await request.delete(`${MOCK}/stream-rules`, { params: { matchText } })
            if (!cleared.ok()) failures.push(`model rule: ${await cleared.text()}`)
          }
          expect(failures).toEqual([])
        }
      })
    }
  }
})

async function postJson(
  request: APIRequestContext,
  url: string,
  data: unknown,
  headers?: Record<string, string>
) {
  const response = await request.post(url, { headers, data })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function getJson(request: APIRequestContext, url: string, headers?: Record<string, string>) {
  const response = await request.get(url, { headers })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function completed(
  request: APIRequestContext,
  taskId: number,
  headers: Record<string, string>
) {
  await expect
    .poll(
      async () => {
        const task = await getJson(request, `${API}/api/tasks/${taskId}/runtime-check`, headers)
        expect(['FAILED', 'CANCELLED']).not.toContain(task.task_status)
        return task.task_status
      },
      { timeout: TIMEOUT }
    )
    .toBe('COMPLETED')
}
