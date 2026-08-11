import assert from 'node:assert/strict'

const PROJECT_ID = '700000000000000001'
const AGENT_ID = 'agent-project-automation'
const RULE_ID = 'automation-rule-1'

const PROJECT = {
  id: PROJECT_ID,
  public_id: 'e2e-project-automation',
  project_key: 'AUTO',
  name: '自动化验收项目',
  description: 'Wework 项目自动化桌面验收',
  created_by_user_id: 9001,
  status: 'active',
  task_provider: 'local',
  access_role: 'Owner',
  version: 1,
  created_at: '2026-08-11T00:00:00',
  updated_at: '2026-08-11T00:00:00',
}

const AGENT = {
  id: AGENT_ID,
  projectId: PROJECT_ID,
  name: 'Bug 修复机器人',
  runtime: 'codex',
  model: null,
  systemPrompt: '',
  executionEnvironment: 'local',
  executionDeviceId: 'desktop-e2e-local-device',
  status: 'active',
  version: 1,
  createdAt: '2026-08-11T00:00:00',
  updatedAt: '2026-08-11T00:00:00',
}

const RULE = {
  id: RULE_ID,
  projectId: PROJECT_ID,
  name: '每天扫描 Bug',
  prompt: '扫描当前项目中的可复现 Bug。',
  cronExpression: '0 3 * * *',
  timezone: 'Asia/Shanghai',
  agentId: AGENT_ID,
  agentName: AGENT.name,
  executionEnvironment: 'local',
  executionDeviceId: AGENT.executionDeviceId,
  enabled: true,
  nextRunAt: '2026-08-12T19:00:00',
  lastRunAt: null,
  lastRunStatus: null,
  version: 1,
  createdAt: '2026-08-11T00:00:00',
  updatedAt: '2026-08-11T00:00:00',
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  const rules = [RULE]
  const runs = []
  let createdPayload = null
  let cancelRequested = false

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [PROJECT] })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/loop-items`
      ) {
        json(response, 200, { items: [] })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/chat-agents`
      ) {
        json(response, 200, [AGENT])
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/automations`
      ) {
        json(response, 200, rules)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT_ID}/automations`
      ) {
        createdPayload = await readJson(request)
        const created = {
          ...RULE,
          id: 'automation-rule-created',
          ...createdPayload,
          agentName: AGENT.name,
          executionEnvironment: AGENT.executionEnvironment,
          executionDeviceId: AGENT.executionDeviceId,
          nextRunAt: '2026-08-12T19:00:00',
          lastRunAt: null,
          lastRunStatus: null,
        }
        rules.push(created)
        json(response, 201, created)
        return true
      }
      const runsMatch = url.pathname.match(
        new RegExp(`^/api/v1/cloud-projects/${PROJECT_ID}/automations/([^/]+)/runs$`)
      )
      if (request.method === 'GET' && runsMatch) {
        json(
          response,
          200,
          runs.filter(run => run.automationId === runsMatch[1])
        )
        return true
      }
      const runNowMatch = url.pathname.match(
        new RegExp(`^/api/v1/cloud-projects/${PROJECT_ID}/automations/([^/]+)/run$`)
      )
      if (request.method === 'POST' && runNowMatch) {
        const run = {
          id: 'automation-run-waiting',
          automationId: runNowMatch[1],
          projectId: PROJECT_ID,
          trigger: 'manual',
          status: 'waiting_device',
          scheduledFor: '2026-08-11T10:00:00',
          expiresAt: null,
          taskId: null,
          deviceId: AGENT.executionDeviceId,
          error: null,
          createdAt: '2026-08-11T10:00:00',
          updatedAt: '2026-08-11T10:00:00',
        }
        runs.unshift(run)
        json(response, 200, run)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname ===
          `/api/v1/cloud-projects/${PROJECT_ID}/automation-runs/automation-run-waiting/cancel`
      ) {
        cancelRequested = true
        runs[0] = { ...runs[0], status: 'cancelled' }
        json(response, 200, runs[0])
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname.startsWith(`/api/v1/cloud-projects/${PROJECT_ID}/executions`)
      ) {
        json(response, 200, { items: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        json(response, 200, {
          devices: [
            {
              device_id: AGENT.executionDeviceId,
              device_name: 'E2E Mac',
              device_type: 'local',
              status: 'offline',
              executor_version: 'e2e',
              capabilities: [],
            },
          ],
        })
        return true
      }
      return false
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-board"]')
      await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="cloud-sidebar-project-${PROJECT_ID}"]`)
      await control.command('waitFor', '[data-testid="cloud-project-automation-view"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-automation-view"]')
      await control.command('waitFor', '[data-testid="project-automation-rules"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="project-automation-create"]')
      await control.command('fill', '[data-testid="project-automation-name"]', {
        value: '凌晨回归扫描',
      })
      await control.command('fill', '[data-testid="project-automation-prompt"]', {
        value: '扫描回归 Bug，并为每个 Bug 创建独立修复任务。',
      })
      await control.command('fill', '[data-testid="project-automation-agent"]', {
        value: AGENT_ID,
      })
      await control.command('click', '[data-testid="project-automation-save"]')
      await control.command(
        'waitFor',
        '[data-testid="project-automation-rule-automation-rule-created"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(createdPayload?.name, '凌晨回归扫描')
      assert.equal(createdPayload?.agentId, AGENT_ID)
      await captureScreenshot(control, 'project-automation-01-created-rule.png')

      await control.command(
        'click',
        '[data-testid="project-automation-rule-automation-rule-created"]'
      )
      await control.command('waitFor', '[data-testid="project-automation-run-now"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="project-automation-run-now"]')
      await control.command(
        'waitFor',
        '[data-testid="project-automation-cancel-run-automation-run-waiting"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        '[data-testid="project-automation-cancel-run-automation-run-waiting"]'
      )
      const cancelDeadline = Date.now() + uiTimeoutMs
      while (!cancelRequested && Date.now() < cancelDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(cancelRequested, true)
      await control.command('click', '[data-testid="cloud-project-automation-view"]')
      await control.command('waitFor', '[data-testid="project-automation-rules"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'project-automation-02-cancelled-run.png')
    },

    diagnostics() {
      return { cancelRequested, createdPayload, rules, runs }
    },
  }
}
