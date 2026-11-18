import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAsyncRequestModel } from '../modules/async-request-model.mjs'
import {
  cleanupAssistantRequestFixture,
  restorePersonalStandInProfile,
  waitForAssistantRequestGrant,
} from '../modules/async-assistant-request-fixture.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readProjectChatMessages } from '../modules/project-chat-snapshot.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'

const MARKER = `ASYNC_REQUESTS_${process.pid}`
const FILE = 'async-request-proof.txt'

/** Standalone prerequisites also run when this checkpoint is selected directly. */
export function createDesktopScenario(options) {
  const { uiTimeoutMs, modelResponseTimeoutMs, workspacePath } = options
  const model = createAsyncRequestModel(MARKER, FILE, async letter => {
    const rows = await messages()
    assert.equal(
      rows.filter(row => row.metadata?.activity_type === 'assistant_request_receipt').length,
      letter === 'A' ? 1 : 2,
      'The server receipt must already be durable before the model can execute tools'
    )
  })
  let cloud, environment, user, project, issue, source, a, b, otherToken
  let authorization, verificationError
  const git = args => {
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'])
      delete env[key]
    return execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      env,
      windowsHide: true,
    }).trim()
  }
  const until = (load, ready, label) => storyUntil(load, ready, modelResponseTimeoutMs, label)
  async function request(path, body, token = cloud.authToken) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const path = () => `/v1/cloud-projects/${project.id}/loop-items/${issue.id}/assistant-requests`
  const list = () => request(path())
  const messages = () =>
    readProjectChatMessages({ ...cloud, projectId: String(project.id) }, issue.id, uiTimeoutMs)
  const receipt = (rows, id) =>
    rows.filter(
      row =>
        row.metadata?.activity_type === 'assistant_request_receipt' &&
        row.metadata.request_id === id
    )
  return {
    requiresCloudEnvironment: true,
    backendEnv: {
      HUMAN_ASSIGNMENT_RECEIPTS_ENABLED: 'true',
      ASYNC_ASSISTANT_REQUESTS_ENABLED: 'true',
    },
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const workspace = await request('/v1/workspaces', { name: MARKER })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: MARKER,
        task_provider: 'local',
      })
      const other = await request('/admin/users', {
        user_name: `async-request-member-${process.pid}`,
        password: 'async-request-e2e-only',
        role: 'user',
        auth_source: 'password',
      })
      otherToken = (
        await request('/auth/login', {
          user_name: other.user_name,
          password: 'async-request-e2e-only',
        })
      ).access_token
      for (const memberPath of [
        `/v1/workspaces/${workspace.id}/members`,
        `/v1/cloud-projects/${project.id}/members`,
      ])
        await request(memberPath, { user_id: other.id, role: 'Developer' })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    handleHttp: model.handleHttp,
    async verify(control) {
      const appDevice = await environment.waitForConnectedAppDevice()
      const rpc = (method, values) => requestExecutor(control, method, values, uiTimeoutMs)
      source = await mkdtemp(join(workspacePath, 'async-source-'))
      git(['init', '-b', 'main'])
      git(['config', 'user.name', 'Wework E2E'])
      git(['config', 'user.email', 'e2e@wegent.local'])
      git(['config', 'core.autocrlf', 'false'])
      await writeFile(join(source, 'tracked.txt'), 'base\n')
      git(['add', 'tracked.txt'])
      git(['commit', '-m', 'Isolated request baseline'])
      const base = git(['rev-parse', 'HEAD'])
      await control.command('seedLocalProject', 'body', {
        value: JSON.stringify({ projectKey: MARKER, name: MARKER, path: source }),
      })
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: options.workbenchReadyTimeoutMs,
      })
      const original = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      const limits = await rpc('runtime.settings.get', {})
      const catalog = await rpc('runtime.runner.catalog', {})
      const selected = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
      assert.ok(selected, 'Use the configured real native Codex model')
      let restoreExperience = false
      try {
        await rpc('runtime.settings.update', { maxConcurrentStandInTasks: 2 })
        const saved = await rpc('runtime.stand_in.personal.save', {
          userId: user.id,
          settings: {
            ...original,
            primary: {
              ...original.primary,
              enabled: true,
              prompt: MARKER,
              preferences: '',
              connections: [],
              model: selected,
              workspace: {
                projectKey: MARKER,
                workspacePath: source,
                executionMode: 'current_workspace',
              },
              collaboration: {
                enabled: true,
                allProjects: false,
                projects: [{ id: String(project.id), store: 'cloud' }],
                excludedProjects: [],
                tags: [MARKER],
                policy: { automatic: true, askBeforeAct: false, immediate: true },
              },
            },
            roles: [],
          },
        })
        authorization = { savedVersion: saved.version, declaration: null }
        await waitForAssistantRequestGrant({
          environment,
          deviceName: appDevice.device_id,
          saved,
          until,
          observe: declaration => {
            authorization.declaration = declaration
          },
        })
        issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
          title: `${MARKER}: prepare independent work`,
          tags: [MARKER],
          assignee_user_id: user.id,
        })
        const dispatch = issue.direct_human_assignment_receipt
        assert.ok(dispatch?.dispatchId, 'The assignment must create its durable dispatch')
        assert.equal(dispatch.ownerUserId, user.id)
        assert.equal(dispatch.issueId, issue.id)
        const initial = await until(
          async () => {
            const bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
            return bindings[0] ? rpc('runtime.tasks.get', { taskId: bindings[0].task_id }) : null
          },
          result => result?.task?.status === 'done' && !result.task.running,
          'Initial authorized assistant must settle before explicit requests'
        )
        assert.equal(
          initial.task.runtimeHandle.origin.humanAssistantDispatchId,
          dispatch.dispatchId,
          'The completed task must belong to the assignment dispatch'
        )
        await writeFile(join(source, 'tracked.txt'), `${MARKER}_PRIVATE_DIRTY_SOURCE\n`)
        await writeFile(
          join(source, 'private-untracked.txt'),
          `${MARKER}_PRIVATE_UNTRACKED_SOURCE\n`
        )

        const action = {
          action: 'new_request',
          idempotencyKey: `${MARKER}-A`,
          message: model.message('A'),
        }
        a = await request(path(), action)
        const firstReceipt = receipt(await messages(), a.requestId)
        assert.equal(firstReceipt.length, 1, 'Acceptance is durable when the API returns')
        assert.equal(firstReceipt[0].metadata.state, 'accepted')
        assert.equal(firstReceipt[0].metadata.execution_entry.requestId, a.requestId)
        assert.equal((await request(path(), action)).requestId, a.requestId)
        assert.equal(
          receipt(await messages(), a.requestId).length,
          1,
          'Network replay must not duplicate the receipt'
        )
        await until(
          () => model.state.waiting,
          values => values.includes('A'),
          'Request A native write must finish and remain running'
        )
        b = await request(path(), {
          action: 'new_request',
          parentRequestId: a.requestId,
          idempotencyKey: `${MARKER}-B`,
          message: model.message('B'),
        })
        assert.equal(b.parentRequestId, a.requestId)
        await until(
          () => model.state.waiting,
          values => values.includes('B'),
          'Request B must run concurrently in its own worktree'
        )
        const running = await until(
          list,
          value => value.requests.length === 2 && value.requests.every(row => row.worktree?.path),
          'Owner worktree metadata must be durable'
        )
        const ra = running.requests.find(row => row.requestId === a.requestId)
        const rb = running.requests.find(row => row.requestId === b.requestId)
        assert.notEqual(ra.runtimeTaskId, rb.runtimeTaskId)
        assert.notEqual(ra.worktree.path, rb.worktree.path)
        assert.notEqual(ra.worktree.branch, rb.worktree.branch)
        for (const [row, letter] of [
          [ra, 'A'],
          [rb, 'B'],
        ]) {
          assert.equal(row.worktree.baseRevision, base)
          assert.equal(row.worktree.cleanupPolicy, 'preserve')
          assert.equal(
            await readFile(join(row.worktree.path, FILE), 'utf8'),
            model.proof(letter),
            'The actual native write must succeed in its own checkout'
          )
          assert.equal(await readFile(join(row.worktree.path, 'tracked.txt'), 'utf8'), 'base\n')
          assert.equal(row.worktree.request.requestId, row.requestId)
          assert.equal(row.worktree.request.ownerUserId, user.id)
          assert.equal(row.worktree.request.conversationId, row.runtimeTaskId)
          await assert.rejects(readFile(join(row.worktree.path, 'private-untracked.txt')), {
            code: 'ENOENT',
          })
        }
        assert.deepEqual(
          (await request(path(), undefined, otherToken)).requests,
          [],
          "Project membership cannot expose another owner's request metadata"
        )
        const foreignCancel = await fetch(`${cloud.backendUrl}/api${path()}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'cancel',
            requestId: b.requestId,
            idempotencyKey: `${MARKER}-foreign-cancel`,
          }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        assert.equal(
          foreignCancel.status,
          404,
          "A project member cannot cancel another owner's request"
        )
        const foreignTranscript = await fetch(`${cloud.backendUrl}/api/runtime-work/transcript`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            deviceId: rb.deviceId,
            taskId: rb.runtimeTaskId,
            projectSession: { projectId: String(project.id), issueId: issue.id },
          }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        assert.equal(
          foreignTranscript.status,
          404,
          "A project member cannot read B's private child transcript"
        )
        assert.equal(
          (await messages()).filter(
            row => row.metadata?.activity_type === 'assistant_request_receipt'
          ).length,
          2
        )
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('navigate', 'body', { value: '/settings' })
        const toggle = '[data-testid="general-collaboration-experience-toggle"]'
        await control.command('waitFor', toggle)
        restoreExperience =
          (await control.command('getAttribute', toggle, { value: 'aria-checked' })) !== 'true'
        if (restoreExperience) {
          await control.command('clickWhenEnabled', toggle)
          await control.command('waitFor', `${toggle}[aria-checked="true"]`)
        }
        await control.command('navigate', 'body', {
          value: `/collaboration-exp?${new URLSearchParams({ view: 'tasks', relevance: 'all', projectStore: 'backend', projectId: String(project.id), issueId: issue.id })}`,
        })
        await control.command('waitFor', `[data-testid="assistant-request-${a.requestId}"]`)
        await control.command('waitFor', `[data-testid="assistant-request-${b.requestId}"]`)
        await request(path(), {
          action: 'followup',
          requestId: a.requestId,
          idempotencyKey: `${MARKER}-A-followup`,
          message: `${MARKER}: keep working on A`,
        })
        assert.equal(
          (await list()).requests.length,
          2,
          'A followup cannot allocate a second request'
        )
        const uiFollowup = `${MARKER}: continue A from the request panel`
        await control.command(
          'clickWhenEnabled',
          `[data-testid="assistant-request-continue-${a.requestId}"]`
        )
        await control.command('waitFor', '[data-testid="assistant-request-message"]')
        await control.command('fill', '[data-testid="assistant-request-message"]', {
          value: uiFollowup,
        })
        await control.command('clickWhenEnabled', '[data-testid="assistant-request-send"]')
        const admitted = await until(
          list,
          value =>
            value.requests
              .find(row => row.requestId === a.requestId)
              ?.commands.some(
                command => command.action === 'followup' && command.message === uiFollowup
              ),
          'The request panel must durably admit its followup to A'
        )
        assert.equal(admitted.requests.length, 2, 'A UI followup cannot create another request')
        const continued = admitted.requests.find(row => row.requestId === a.requestId)
        assert.equal(continued.runtimeTaskId, ra.runtimeTaskId)
        assert.equal(continued.conversationId, ra.conversationId)
        assert.equal(continued.worktree.path, ra.worktree.path)
        assert.equal(continued.worktree.branch, ra.worktree.branch)
        await request(path(), {
          action: 'cancel',
          requestId: b.requestId,
          idempotencyKey: `${MARKER}-B-cancel`,
        })
        await until(
          list,
          value => value.requests.find(row => row.requestId === b.requestId)?.state === 'cancelled',
          'Cancellation must settle only B'
        )
        assert.equal(
          await readFile(join(rb.worktree.path, FILE), 'utf8'),
          model.proof('B'),
          'Cancelled request evidence must remain intact'
        )
        const stillRunning = await rpc('runtime.tasks.get', { taskId: ra.runtimeTaskId })
        assert.equal(stillRunning.task.running, true, 'Cancelling B must leave A running')
        model.release('A')
        const completed = await until(
          list,
          value =>
            value.requests.find(row => row.requestId === a.requestId)?.worktree?.merge?.state ===
            'awaiting_confirmation',
          'A must produce a validation candidate before explicit owner publication'
        )
        const finished = completed.requests.find(row => row.requestId === a.requestId)
        assert.equal(finished.runtimeTaskId, ra.runtimeTaskId)
        assert.equal(finished.worktree.path, ra.worktree.path)
        assert.equal(
          git(['rev-parse', 'HEAD']),
          base,
          'Preparing a candidate cannot advance the source branch'
        )
        assert.equal(
          await readFile(join(source, 'tracked.txt'), 'utf8'),
          `${MARKER}_PRIVATE_DIRTY_SOURCE\n`
        )
        const shared = JSON.stringify(await messages())
        for (const secret of [
          ra.worktree.path,
          rb.worktree.path,
          model.proof('A').trim(),
          model.proof('B').trim(),
          'PRIVATE_DIRTY_SOURCE',
          'PRIVATE_UNTRACKED_SOURCE',
        ])
          assert.ok(
            !shared.includes(secret),
            'Private paths, source data and tool contents must remain in child workrooms'
          )
        assert.equal((await list()).requests.length, 2)
      } catch (error) {
        verificationError = error
        throw error
      } finally {
        await cleanupAssistantRequestFixture(
          [
            () => model.cleanup(),
            async () => {
              if (a)
                await request(path(), {
                  action: 'cancel',
                  requestId: a.requestId,
                  idempotencyKey: `${MARKER}-cleanup-A`,
                })
            },
            async () => {
              if (b)
                await request(path(), {
                  action: 'cancel',
                  requestId: b.requestId,
                  idempotencyKey: `${MARKER}-cleanup-B`,
                })
            },
            () => restorePersonalStandInProfile(rpc, user.id, original),
            () => rpc('runtime.settings.update', limits),
            async () => {
              if (restoreExperience) {
                await control.command('navigate', 'body', { value: '/settings' })
                const toggle = '[data-testid="general-collaboration-experience-toggle"]'
                await control.command('waitFor', toggle)
                await control.command('clickWhenEnabled', toggle)
                await control.command('waitFor', `${toggle}[aria-checked="false"]`)
              }
            },
          ],
          verificationError
        )
      }
    },
    diagnostics() {
      return {
        projectId: project?.id,
        issueId: issue?.id,
        assignmentReceipt: issue?.direct_human_assignment_receipt,
        source,
        requestA: a?.requestId,
        requestB: b?.requestId,
        authorization,
        verificationError: verificationError ? String(verificationError.stack) : null,
        ...model.state,
      }
    },
    cleanup: model.cleanup,
  }
}
