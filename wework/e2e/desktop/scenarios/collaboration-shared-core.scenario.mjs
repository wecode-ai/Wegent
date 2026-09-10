// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = {
  id: '896185331840201899',
  public_id: 'e2e-collaboration-shared-core',
  project_key: 'SHARED',
  name: '协作共享核心',
  description: 'Web 与 Wework 使用同一协作领域组件',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 9001,
  current_user_id: 9001,
  current_user_name: 'admin',
  access_role: 'Owner',
  visibility: 'private',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00',
  updated_at: '2026-09-10T00:00:00',
}
const AGENT = {
  id: 'shared-agent-1',
  projectId: PROJECT.id,
  name: '共享回归机器人',
  runtime: 'codex',
  model: null,
  systemPrompt: '',
  capabilityDescription: '验证共享自动化',
  status: 'active',
  visibility: 'creator_admin',
  executionEnvironment: 'cloud',
  executionMode: 'auto',
  executionDeviceId: null,
  maxConcurrentExecutions: 1,
  workspacePolicy: 'project',
  version: 1,
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

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const hooks = []
  const rules = []
  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [PROJECT] })
        return true
      }
      if (request.method === 'GET' && url.pathname === `/api/v1/cloud-projects/${PROJECT.id}`) {
        json(response, 200, PROJECT)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT.id}/board-snapshot`
      ) {
        json(response, 200, { items: [], task_bindings: [], members: [], agents: [AGENT] })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT.id}/incoming-hooks`
      ) {
        json(response, 200, hooks)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT.id}/incoming-hooks`
      ) {
        const body = await readJson(request)
        const hook = {
          id: 'shared-hook-1',
          projectId: PROJECT.id,
          status: 'active',
          webhookUrl: 'https://cloud.example/hooks/shared-hook-1',
          pollIntervalSeconds: null,
          credentialRef: null,
          health: {},
          lastEventAt: null,
          nextPollAt: null,
          version: 1,
          createdAt: '2026-09-10T00:00:00',
          updatedAt: '2026-09-10T00:00:00',
          ...body,
        }
        hooks.push(hook)
        json(response, 201, hook)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT.id}/automations`
      ) {
        json(response, 200, rules)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT.id}/automations`
      ) {
        const body = await readJson(request)
        const rule = {
          id: 'shared-rule-1',
          projectId: PROJECT.id,
          agentName: AGENT.name,
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          version: 1,
          createdAt: '2026-09-10T00:00:00',
          updatedAt: '2026-09-10T00:00:00',
          ...body,
        }
        rules.push(rule)
        json(response, 201, rule)
        return true
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command(
        'waitFor',
        '[data-testid="wework-collaboration-workspace"] [data-testid="collaboration-root"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', '[data-testid="collaboration-project-list"]', {
        timeoutMs: uiTimeoutMs,
      })
      const homeSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      const projectTestId = homeSnapshot.testIds.find(testId =>
        testId.startsWith('collaboration-project-wework-project:')
      )
      assert.ok(projectTestId, 'The shared collaboration project card was not rendered in Wework')
      await control.command('click', `[data-testid="${projectTestId}"]`)
      await control.command('waitFor', '[data-testid="collaboration-board"]', {
        timeoutMs: uiTimeoutMs,
      })

      const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.ok(
        snapshot.testIds.includes('wework-collaboration-workspace'),
        'The Wework collaboration module did not mount the shared collaboration surface'
      )
      assert.ok(
        snapshot.text.includes(PROJECT.name),
        'The shared collaboration project header was not rendered in Wework'
      )
      assert.ok(
        !snapshot.testIds.includes('collaboration-open-desktop-workspace'),
        'Wework still exposed a route back to the duplicate desktop project-space UI'
      )
      await control.command('click', '[data-testid="collaboration-tab-automation"]')
      await control.command('waitFor', '[data-testid="collaboration-automation"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="automation-create-rule"]')
      await control.command('fill', '[data-testid="automation-editor-name-input"]', {
        value: '共享事件自动化',
      })
      await control.command('fill', '[data-testid="automation-rule-description"]', {
        value: '验证 Wework 与 Web 使用相同自动化编辑器。',
      })
      await control.command('select', '[data-testid="automation-trigger-type"]', {
        value: 'event',
      })
      await control.command('select', '[data-testid="automation-external-event-type"]', {
        value: 'change_request.checks_failed',
      })
      await control.command('click', '[data-testid="event-subscription-add"]')
      await control.command('fill', '[data-testid="event-subscription-name"]', {
        value: '共享 GitHub Webhook',
      })
      await control.command('fill', '[data-testid="event-subscription-resource-url"]', {
        value: 'https://github.com/acme/shared',
      })
      await control.command('clickWhenEnabled', '[data-testid="event-subscription-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="automation-agent"]', {
        value: AGENT.id,
      })
      await control.command('clickWhenEnabled', '[data-testid="automation-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="automation-rule-shared-rule-1"]', {
        text: '共享事件自动化',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(hooks.length, 1)
      assert.equal(rules.length, 1)
      assert.equal(rules[0].eventConfig.subscription_id, hooks[0].id)
      await captureScreenshot(control, 'collaboration-shared-core.png', ACTIVE_WORKBENCH_SELECTOR)
    },
  }
}
