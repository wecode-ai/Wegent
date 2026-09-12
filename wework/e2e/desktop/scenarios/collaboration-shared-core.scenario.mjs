import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const COLLABORATION_HOST_SELECTOR = '[data-testid="app-iframe-collaboration"]'
const WORKSPACE_NAME = '协作共享核心空间'
const PROJECT_NAME = '协作共享核心验收'
const ISSUE_TITLE = '验证共享协作主流程'
const COMMENT_BODY = 'Wework 真实桌面 E2E 评论'
const HUMAN_ASSIGNMENT_COMMENT = '请处理需求确认'
const HUMAN_WORKFLOW_STEP = '需求确认'
const AGENT_ASSIGNMENT_COMMENT = '请处理实现步骤'
const AGENT_WORKFLOW_STEP = '实现'
const AGENT_NAME = '协作核心 Codex'
const TASK_PROMPT = '检查当前 Issue 并开始执行'
const BRIDGE_RUNTIME_FILE = 'embedded-browser-bridge.json'
const scenarioDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scenarioDir, '..', '..', '..', '..')
const frontendDir = join(repositoryRoot, 'frontend')
const nextCliPath = join(frontendDir, 'node_modules', 'next', 'dist', 'bin', 'next')

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

async function waitForApiValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Unable to reserve a frontend port')
  await new Promise(resolvePromise => server.close(resolvePromise))
  return address.port
}

async function waitForFrontend(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latestError = 'Frontend has not responded'
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `Collaboration frontend exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${url}/collaboration`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      })
      if (response.status < 500) return
      latestError = `HTTP ${response.status}`
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for Collaboration frontend: ${latestError}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function waitForBridgeIdentity(executorHome, timeoutMs) {
  const runtimePath = join(executorHome, 'runtime', BRIDGE_RUNTIME_FILE)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const content = await readFile(runtimePath, 'utf8').catch(() => '')
    if (content) {
      const record = JSON.parse(content)
      if (record.schemaVersion === 1 && record.address && record.token) {
        return { baseUrl: `http://${record.address}`, token: record.token }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for authenticated embedded browser bridge runtime')
}

async function callBridge(identity, label, payload) {
  const requestTimeoutMs = Math.max(Number(payload.timeoutMs ?? 0), 15_000) + 2_000
  const response = await fetch(`${identity.baseUrl}/browser`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${identity.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label, ...payload }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  const body = await response.json()
  assert.equal(response.ok, true, `Embedded browser bridge HTTP failed: ${JSON.stringify(body)}`)
  assert.equal(body.ok, true, `Embedded browser action failed: ${JSON.stringify(body)}`)
  return body.data
}

async function pageValue(bridge, expression) {
  const result = await bridge({
    action: 'evaluate',
    expression,
    timeoutMs: 5_000,
  })
  assert.equal(result.ok, true, `Embedded browser evaluation failed: ${JSON.stringify(result)}`)
  return result.value
}

async function waitForPageValue(bridge, load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

async function waitForEmbeddedSelector(bridge, selector, timeoutMs) {
  return waitForPageValue(
    bridge,
    () => pageValue(bridge, `Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    value => value === true,
    `Timed out waiting for embedded Collaboration selector ${selector}`,
    timeoutMs
  )
}

async function clickEmbedded(control, browserLabel, bridge, selector) {
  const target = await pageValue(
    bridge,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        disabled: Boolean(element.disabled),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      }
    })()`
  )
  assert.ok(target, `Could not find embedded selector ${selector}`)
  assert.equal(target.disabled, false, `Embedded selector ${selector} is disabled`)
  const result = await bridge({
    action: 'nativeClick',
    x: target.x,
    y: target.y,
    timeoutMs: 5_000,
  })
  assert.equal(
    result.ok,
    true,
    `Could not click embedded selector ${selector}: ${JSON.stringify(result)}`
  )
  await control.command('setEmbeddedBrowserAgentControlPaused', 'body', {
    value: JSON.stringify({ label: browserLabel, paused: false }),
  })
}

async function fillEmbedded(bridge, selector, text) {
  const result = await bridge({
    action: 'fill',
    selector,
    text,
    timeoutMs: 5_000,
  })
  assert.equal(
    result.ok,
    true,
    `Could not fill embedded selector ${selector}: ${JSON.stringify(result)}`
  )
}

async function embeddedPathname(bridge) {
  return pageValue(bridge, 'window.location.pathname')
}

function finalPathSegment(pathname) {
  return decodeURIComponent(pathname.split('/').filter(Boolean).at(-1) ?? '')
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backendUrl = ''
  let authToken = ''
  let owner = null
  let workspace = null
  let project = null
  let issue = null
  let agent = null
  let frontend = null
  let frontendLog = null
  let frontendUrl = ''
  let fixtureArchived = false

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  async function stopFrontend() {
    const child = frontend
    const log = frontendLog
    frontend = null
    frontendLog = null
    await stopChild(child)
    log?.end()
  }

  async function archiveFixture() {
    if (fixtureArchived) return
    try {
      if (project) {
        const latestProject = await request(`/api/v1/cloud-projects/${project.id}`)
        if (latestProject.status !== 'archived') {
          await request(`/api/v1/cloud-projects/${project.id}?version=${latestProject.version}`, {
            method: 'DELETE',
          })
        }
      }
      if (workspace) {
        const latestWorkspace = await request(`/api/v1/workspaces/${workspace.id}`)
        if (latestWorkspace.status !== 'archived') {
          await request(`/api/v1/workspaces/${workspace.id}?version=${latestWorkspace.version}`, {
            method: 'DELETE',
          })
        }
      }
    } finally {
      await stopFrontend()
      fixtureArchived = true
    }
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      owner = await request('/api/users/me')
      await request('/api/admin/setup-complete', { method: 'POST' })
      const frontendPort = await reservePort()
      frontendUrl = `http://127.0.0.1:${frontendPort}`
      frontendLog = createWriteStream(join(resultDir, 'collaboration-frontend.log'), {
        flags: 'a',
      })
      await new Promise((resolvePromise, reject) => {
        frontendLog.once('open', resolvePromise)
        frontendLog.once('error', reject)
      })
      try {
        frontend = spawn(
          process.execPath,
          [
            '--max-old-space-size=4096',
            nextCliPath,
            'dev',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(frontendPort),
          ],
          {
            cwd: frontendDir,
            env: {
              ...process.env,
              NEXT_PUBLIC_API_URL: '',
              RUNTIME_INTERNAL_API_URL: backendUrl,
            },
            stdio: ['ignore', frontendLog, frontendLog],
          }
        )
        await waitForFrontend(frontendUrl, frontend, workbenchReadyTimeoutMs)
        await cloud.setFrontendUrl(frontendUrl)
      } catch (error) {
        await stopFrontend()
        throw error
      }
    },

    async verify(control) {
      assert.ok(owner?.id, 'The collaboration owner fixture is missing')
      assert.ok(frontendUrl, 'The Collaboration frontend fixture is missing')

      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', scoped('[data-testid="app-iframe-collaboration"]'), {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getAttribute',
            '[data-testid="workspace-tab-select-fixed-board"]',
            { value: 'aria-selected' }
          ),
          'true',
          'Opening Collaboration did not activate the fixed Collaboration tab'
        )

        const platformSnapshot = await snapshot(control)
        assert.ok(
          platformSnapshot.testIds.includes('app-iframe-collaboration'),
          'The fixed Collaboration tab did not host Wegent Web'
        )
        const browserLabel = await control.command('getAttribute', COLLABORATION_HOST_SELECTOR, {
          value: 'data-embedded-browser-label',
        })
        assert.ok(browserLabel, 'The Collaboration host did not expose its embedded browser label')
        const bridgeIdentity = await waitForBridgeIdentity(executorHome, uiTimeoutMs)
        const bridge = payload => callBridge(bridgeIdentity, browserLabel, payload)

        await waitForEmbeddedSelector(
          bridge,
          '[data-testid="collaboration-platform-root"]',
          uiTimeoutMs
        )
        await waitForEmbeddedSelector(
          bridge,
          '[data-testid="collaboration-workspace-create"]',
          uiTimeoutMs
        )
        await capture(control, 'collaboration-shared-core-01-all-workspaces.png')

        const workspaceName = `${WORKSPACE_NAME}-${process.pid}`
        await clickEmbedded(
          control,
          browserLabel,
          bridge,
          '[data-testid="collaboration-workspace-create"]'
        )
        await waitForEmbeddedSelector(
          bridge,
          '[data-testid="collaboration-workspace-name-input"]',
          uiTimeoutMs
        )
        await fillEmbedded(
          bridge,
          '[data-testid="collaboration-workspace-name-input"]',
          workspaceName
        )
        await fillEmbedded(
          bridge,
          '[data-testid="collaboration-workspace-description-input"]',
          'Created through the real Wework embedded Collaboration UI.'
        )
        await clickEmbedded(
          control,
          browserLabel,
          bridge,
          '[data-testid="collaboration-workspace-create-confirm"]'
        )
        const workspacePath = await waitForPageValue(
          bridge,
          () => embeddedPathname(bridge),
          value => /^\/collaboration\/workspaces\/[^/]+$/.test(value),
          'Creating a Workspace through the embedded Collaboration UI did not navigate',
          uiTimeoutMs
        )
        const workspaceId = finalPathSegment(workspacePath)
        workspace = await request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`)
        assert.equal(workspace.name, workspaceName)
        await waitForEmbeddedSelector(
          bridge,
          '[data-testid="collaboration-workspace-project-create"]',
          uiTimeoutMs
        )
        await capture(control, 'collaboration-shared-core-02-workspace-created.png')

        const projectName = `${PROJECT_NAME}-${process.pid}`
        await clickEmbedded(
          control,
          browserLabel,
          bridge,
          '[data-testid="collaboration-workspace-project-create"]'
        )
        await waitForEmbeddedSelector(
          bridge,
          '[data-testid="collaboration-project-name-input"]',
          uiTimeoutMs
        )
        await fillEmbedded(bridge, '[data-testid="collaboration-project-name-input"]', projectName)
        await fillEmbedded(
          bridge,
          '[data-testid="collaboration-project-description-input"]',
          'Created through Workspace → Project in the Wework built-in browser.'
        )
        await clickEmbedded(
          control,
          browserLabel,
          bridge,
          '[data-testid="collaboration-project-create-confirm"]'
        )
        const projectPath = await waitForPageValue(
          bridge,
          () => embeddedPathname(bridge),
          value =>
            new RegExp(
              `^/collaboration/workspaces/${encodeURIComponent(workspace.id)}/projects/[^/]+$`
            ).test(value),
          'Creating a Project through the embedded Collaboration UI did not navigate',
          uiTimeoutMs
        )
        const projectId = finalPathSegment(projectPath)
        project = await request(`/api/v1/cloud-projects/${encodeURIComponent(projectId)}`)
        assert.equal(project.name, projectName)
        const persistedWorkspace = await request(`/api/v1/workspaces/${workspace.id}`)
        assert.equal(persistedWorkspace.project_count, 1)
        const persistedProjects = await request(`/api/v1/workspaces/${workspace.id}/projects`)
        assert.ok(persistedProjects.items.some(candidate => candidate.id === project.id))
        await waitForEmbeddedSelector(bridge, '[data-testid="collaboration-board"]', uiTimeoutMs)
        await capture(control, 'collaboration-shared-core-03-project-created.png')

        await clickEmbedded(
          control,
          browserLabel,
          bridge,
          '[data-testid="collaboration-issue-create"]'
        )
        await waitForEmbeddedSelector(bridge, '[data-testid="cloud-todo-title"]', uiTimeoutMs)
        await fillEmbedded(bridge, '[data-testid="cloud-todo-title"]', ISSUE_TITLE)
        await fillEmbedded(
          bridge,
          '[data-testid="cloud-todo-detail-description"]',
          '验证共享界面、评论、分配与 Wework 本地 Task 创建桥。'
        )
        await clickEmbedded(
          control,
          browserLabel,
          bridge,
          '[data-testid="cloud-todo-create-confirm"]'
        )
        const issuePath = await waitForPageValue(
          bridge,
          () => embeddedPathname(bridge),
          value =>
            new RegExp(
              `^/collaboration/workspaces/${encodeURIComponent(
                workspace.id
              )}/projects/${encodeURIComponent(project.id)}/issues/[^/]+$`
            ).test(value),
          'Creating an Issue through the embedded Collaboration UI did not navigate',
          uiTimeoutMs
        )
        const issueId = finalPathSegment(issuePath)
        issue = await request(`/api/v1/loop-items/${encodeURIComponent(issueId)}`)
        assert.equal(issue.title, ISSUE_TITLE)
        await waitForEmbeddedSelector(
          bridge,
          '[data-testid="collaboration-issue-detail"]',
          uiTimeoutMs
        )
        await capture(control, 'collaboration-shared-core-04-issue-created.png')

        agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
          method: 'POST',
          body: JSON.stringify({
            name: AGENT_NAME,
            runtime: 'codex',
            systemPrompt: 'Complete the assigned project work.',
            capabilityDescription: 'Desktop E2E project implementation agent',
            visibility: 'creator_admin',
            executionEnvironment: 'local',
            executionMode: 'manual_approval',
            workspaceBinding: { type: 'standalone' },
            maxConcurrentExecutions: 1,
            workspacePolicy: 'project',
            plugins: [],
          }),
        })

        await control.command('click', '[data-testid="workspace-tab-add"]')
        await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-add-board"]')
        await control.command('waitFor', scoped('[data-testid="cloud-todo-workspace"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('navigate', 'body', {
          value: `/todo?projectStore=backend&projectId=${encodeURIComponent(project.id)}`,
        })
        await control.command('waitFor', scoped('[data-testid="cloud-todo-workspace"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`), {
          text: ISSUE_TITLE,
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, 'collaboration-shared-core-05-project-board.png')

        await control.command('click', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
        await control.command('waitFor', scoped('[data-testid="cloud-todo-detail"]'), {
          timeoutMs: uiTimeoutMs,
        })
        const activitySelector = scoped(`[data-testid="cloud-task-activity-${issue.id}"]`)
        const activityListSelector = scoped('[data-testid="cloud-task-activity-list"]')
        const activityComposerSelector = scoped('[data-testid="cloud-task-activity-composer"]')
        await control.command('waitFor', activitySelector, { timeoutMs: uiTimeoutMs })
        assert.equal(
          await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
          ISSUE_TITLE,
          'The mature Wework Issue detail did not load the selected real backend Issue'
        )

        await control.command('fill', activityComposerSelector, {
          value: COMMENT_BODY,
        })
        await control.command('press', activityComposerSelector, { key: 'Enter' })
        await control.command('waitFor', activityListSelector, {
          text: COMMENT_BODY,
          timeoutMs: uiTimeoutMs,
        })

        await request(`/api/v1/loop-items/${issue.id}/assignments`, {
          method: 'POST',
          body: JSON.stringify({
            target_type: 'human',
            target_id: String(owner.id),
            workflow_step: HUMAN_WORKFLOW_STEP,
            comment_body: HUMAN_ASSIGNMENT_COMMENT,
            notify_target: false,
          }),
        })
        await request(`/api/v1/loop-items/${issue.id}/assignments`, {
          method: 'POST',
          body: JSON.stringify({
            target_type: 'agent',
            target_id: agent.id,
            workflow_step: AGENT_WORKFLOW_STEP,
            comment_body: AGENT_ASSIGNMENT_COMMENT,
            notify_target: false,
          }),
        })
        const assignments = await request(`/api/v1/loop-items/${issue.id}/assignments`)
        assert.ok(
          assignments.items.some(
            assignment =>
              assignment.target_type === 'human' &&
              assignment.target_id === String(owner.id) &&
              assignment.workflow_step === HUMAN_WORKFLOW_STEP
          ),
          'The real backend did not persist the human workflow-step assignment'
        )
        assert.ok(
          assignments.items.some(
            assignment =>
              assignment.target_type === 'agent' &&
              assignment.target_id === agent.id &&
              assignment.workflow_step === AGENT_WORKFLOW_STEP
          ),
          'The real backend did not persist the Agent workflow-step assignment'
        )
        await capture(control, 'collaboration-shared-core-06-issue-activity.png')

        await control.command('click', scoped('[data-testid="cloud-todo-create-task"]'))
        await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('[data-testid="work-item-new-task-chat-panel"]'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          scoped(
            '[data-testid="work-item-new-task-chat-panel"] [data-testid="chat-message-input"]'
          ),
          {
            timeoutMs: uiTimeoutMs,
          }
        )
        const bridgeSnapshot = await snapshot(control)
        assert.ok(
          bridgeSnapshot.text.includes(project.name) &&
            bridgeSnapshot.text.includes(issue.id) &&
            bridgeSnapshot.text.includes(ISSUE_TITLE),
          'The Wework local Task bridge did not retain the Project and Issue context'
        )
        await capture(control, 'collaboration-shared-core-07-local-task-bridge.png')

        const taskComposer = scoped(
          '[data-testid="work-item-new-task-chat-panel"] [data-testid="chat-message-input"]'
        )
        await control.command('fill', taskComposer, { value: TASK_PROMPT })
        await control.command('press', taskComposer, { key: 'Enter' })
        const taskBindings = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}/tasks`),
          value => Array.isArray(value) && value.length > 0,
          'Starting work did not bind the new Wework local Task to the Issue',
          uiTimeoutMs
        )
        const binding = taskBindings[0]
        assert.ok(binding.deviceId ?? binding.device_id, 'The Task binding has no device identity')
        assert.ok(
          binding.taskId ?? binding.task_id,
          'The Task binding has no runtime task identity'
        )
        const updatedIssue = await waitForApiValue(
          () => request(`/api/v1/loop-items/${issue.id}`),
          value => ['in_progress', 'in_review'].includes(value?.status),
          'Starting the Wework local Task did not project its runtime status to the Issue',
          uiTimeoutMs
        )
        assert.notEqual(updatedIssue.status, 'inbox')
        await capture(control, 'collaboration-shared-core-08-local-task-bound.png')
      } finally {
        await archiveFixture()
      }
    },

    async cleanup() {
      await archiveFixture()
    },

    diagnostics() {
      return {
        agentId: agent?.id ?? null,
        fixtureArchived,
        issueId: issue?.id ?? null,
        projectId: project?.id ?? null,
        workspaceId: workspace?.id ?? null,
      }
    },
  }
}
