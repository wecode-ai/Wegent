import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createDesktopScenario as createMobilePayload } from './mobile-local-payload.scenario.mjs'
import { loadMobileLocalPayloadBuilders } from '../modules/mobile-local-payload-builders.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_MOBILE_WORKTREE'
const DONE = 'WEWORK_MOBILE_WORKTREE_DONE'
const run = promisify(execFile)

// Extend the existing checkpoint in its existing isolated runtime and CI shard.
// The native phone supervisor is outside this desktop payload verification.
export function createDesktopScenario(options) {
  const existing = createMobilePayload(options)
  let active = false
  return {
    ...existing,
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(
        JSON.stringify(body.input).includes(PROMPT),
        'Worktree continuation lost its history'
      )
      const id = randomUUID()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), assistantMessage(DONE), responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await existing.verify(control)
      const rpc = (method, input) => requestExecutor(control, method, input, options.uiTimeoutMs)
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const deviceId = snapshot.workbench?.currentRuntimeTask?.deviceId
      assert.ok(deviceId)
      const sourcePath = join(options.workspacePath, 'mobile-worktree-source')
      await mkdir(sourcePath, { recursive: true })
      const git = (...args) => run('git', ['-C', sourcePath, ...args])
      await git('init', '-b', 'main')
      await writeFile(join(sourcePath, 'starting-point.txt'), 'main')
      await git('add', '.')
      await git(
        '-c',
        'user.name=Wework Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'base'
      )
      await git('checkout', '-b', 'feature/mobile')
      await writeFile(join(sourcePath, 'starting-point.txt'), 'selected branch')
      await git(
        '-c',
        'user.name=Wework Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-am',
        'selected branch'
      )
      await git('checkout', 'main')

      const builders = await loadMobileLocalPayloadBuilders()
      const probe = await builders.probeWorkspaceWorktreeAvailability({
        api: {
          getWorktreeCapabilities: input => rpc('runtime.worktrees.capabilities', input),
          preflightWorktree: input => rpc('runtime.worktrees.preflight', input),
        },
        workspace: { deviceId, workspacePath: sourcePath, available: true, tasks: [] },
        device: { device_id: deviceId, device_type: 'local', status: 'online' },
        ref: 'feature/mobile',
      })
      assert.equal(probe.available, true, JSON.stringify(probe))
      const listed = await builders.listWorkspaceBranches(
        input => rpc('runtime.worktrees.preflight', input),
        { deviceId, sourcePath }
      )
      assert.equal(listed[0], 'main')
      assert.ok(listed.includes('feature/mobile'))

      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(item => item.label === 'Mobile Responses')
      assert.ok(model, 'The preceding mobile payload must configure its real model profile')
      const taskId = randomUUID()
      const modelOptions = { permissionMode: 'full-access', runnerModelProvider: model.provider }
      const modelConfig = builders.resolveLocalRuntimeModelConfig({
        runtime: 'codex',
        modelName: model.model_id,
        modelType: 'runtime',
        modelOptions,
      })
      const executionRequest = (newSession, workspacePath) =>
        builders.buildLocalRuntimeExecutionRequest({
          taskId,
          runtime: 'codex',
          title: PROMPT,
          message: PROMPT,
          clientUserMessageId: `${taskId}-${newSession ? 'initial' : 'follow-up'}`,
          turnSeed: newSession ? 1 : 2,
          modelOptions,
          modelConfig,
          reasoningConfig: null,
          localDeviceId: deviceId,
          workspacePath,
          workspaceSource: newSession ? 'git_worktree' : 'local_path',
          ...(newSession ? { branch: 'feature/mobile' } : {}),
          newSession,
          user: { id: 0, user_name: 'local', email: 'local@wework.local' },
        })
      active = true
      const created = await rpc('runtime.tasks.create', {
        schemaVersion: 2,
        deviceId,
        taskId,
        runtime: 'codex',
        workspacePath: sourcePath,
        title: PROMPT,
        message: PROMPT,
        clientUserMessageId: `${taskId}-initial`,
        modelId: model.model_id,
        modelType: 'runtime',
        modelOptions,
        execution: { workspace: { source: 'git_worktree', branch: 'feature/mobile' } },
        executionRequest: executionRequest(true, sourcePath),
      })
      assert.equal(created.accepted, true, created.error)
      const address = { deviceId, taskId, runtime: 'codex' }
      const complete = previousTurnId =>
        waitForValue(
          async () => {
            const { task } = await rpc('runtime.tasks.get', { address })
            assert.notEqual(task?.executionState?.outcome, 'failed', task?.error)
            return task
          },
          task =>
            task?.executionState?.phase === 'idle' &&
            task.executionState.outcome === 'succeeded' &&
            (!previousTurnId || task.executionState.latestTurnId !== previousTurnId),
          'Mobile worktree execution did not complete',
          options.modelResponseTimeoutMs
        )
      const initial = await complete()
      assert.ok(initial.threadId)
      assert.ok(initial.executionState.latestTurnId)
      assert.equal(initial.workspaceKind, 'worktree')
      assert.notEqual(initial.workspacePath, sourcePath)
      assert.equal(
        await readFile(join(initial.workspacePath, 'starting-point.txt'), 'utf8'),
        'selected branch'
      )
      assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main')
      const sent = await rpc('runtime.tasks.send', {
        address: { ...address, workspacePath: initial.workspacePath },
        taskId,
        message: PROMPT,
        clientUserMessageId: `${taskId}-follow-up`,
        modelSelection: {
          modelName: model.model_id,
          modelType: 'runtime',
          options: modelOptions,
        },
        executionRequest: executionRequest(false, initial.workspacePath),
      })
      assert.equal(sent.accepted, true, sent.error)
      const continued = await complete(initial.executionState.latestTurnId)
      assert.equal(continued.threadId, initial.threadId)
      assert.equal(continued.workspacePath, initial.workspacePath)
      await writeFile(
        join(options.resultDir, 'mobile-worktrees.json'),
        JSON.stringify({ address, listed, initial, continued }, null, 2)
      )
    },
  }
}
